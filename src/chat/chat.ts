import WebSocket, {MessageEvent} from "isomorphic-ws"
import {ChatCmd, ChatType, ChzzkChatOptions, ChzzkChatOptionsWithClient, Events} from "./types"
import {ChzzkClient} from "../client"
import {ChzzkAPIBaseUrls} from "../types"
import {DEFAULT_BASE_URLS, IS_BROWSER} from "../const"

export class ChzzkChat {
    private _connected: boolean = false

    private readonly client: ChzzkClient
    private ws: WebSocket
    private options: ChzzkChatOptions
    private uid?: string
    private sid?: string
    private handlers: [string, (data: any) => void][] = []
    private defaults = {}
    private pingTimeoutId = null
    private pollIntervalId = null
    private isReconnect = false

    constructor(options: ChzzkChatOptionsWithClient) {
        if (options.pollInterval && !options.channelId) {
            throw new Error('channelId is required for polling')
        }

        if (!options.chatChannelId && !options.channelId) {
            throw new Error('channelId or chatChannelId is required')
        }

        if (IS_BROWSER && options.baseUrls == DEFAULT_BASE_URLS) {
            if (options.pollInterval) {
                throw new Error('Custom baseUrls are required for polling in browser')
            }

            if (!options.chatChannelId) {
                throw new Error('chatChannelId is required in browser if not using custom baseUrls')
            }

            if (!options.accessToken) {
                throw new Error('accessToken is required in browser if not using custom baseUrls')
            }
        }

        this.options = options
        this.options.baseUrls = options.baseUrls ?? DEFAULT_BASE_URLS
        this.client = options.client ?? new ChzzkClient({baseUrls: options.baseUrls})
    }

    static fromClient(chatChannelId: string, client: ChzzkClient) {
        return new ChzzkChat({
            chatChannelId,
            client,
            baseUrls: client.options.baseUrls
        })
    }

    static fromAccessToken(chatChannelId: string, accessToken: string, uid?: string, baseUrls?: ChzzkAPIBaseUrls) {
        const chzzkChat = new ChzzkChat({
            chatChannelId,
            accessToken,
            baseUrls
        })

        chzzkChat.uid = uid

        return chzzkChat
    }

    get connected() {
        return this._connected
    }

    get chatChannelId() {
        return this.options.chatChannelId
    }

    async connect() {
        if (this._connected) {
            throw new Error('Already connected')
        }

        if (this.options.channelId && !this.options.chatChannelId) {
            const status = await this.client.live.status(this.options.channelId)

            this.options.chatChannelId = status.chatChannelId
        }

        if (this.options.chatChannelId && !this.options.accessToken) {
            this.uid = this.client.hasAuth ?
                await this.client.user().then(user => user.userIdHash) :
                null

            this.options.accessToken = await this.client.chat.accessToken(this.options.chatChannelId)
                .then(token => token.accessToken)
        }

        this.defaults = {
            cid: this.options.chatChannelId,
            svcid: "game",
            ver: "2"
        }

        const serverId = Math.abs(
            this.options.chatChannelId.split("")
                .map(c => c.charCodeAt(0))
                .reduce((a, b) => a + b)
        ) % 9 + 1

        this.ws = new WebSocket(`wss://kr-ss${serverId}.chat.naver.com/chat`)

        this.ws.onopen = () => {
            this.ws.send(JSON.stringify({
                bdy: {
                    accTkn: this.options.accessToken,
                    auth: this.uid ? "SEND" : "READ",
                    devType: 2001,
                    uid: this.uid
                },
                cmd: ChatCmd.CONNECT,
                tid: 1,
                ...this.defaults
            }))

            if (!this.isReconnect) {
                this.startPolling()
            }
        }

        this.ws.onmessage = this.handleMessage.bind(this)

        this.ws.onclose = () => {
            if (!this.isReconnect) {
                this.emit('disconnect', this.options.chatChannelId)
                this.stopPolling()
                this.options.chatChannelId = null
            }

            this.stopPingTimer()

            this.ws = null

            if (this._connected) {
                this.disconnect()
            }
        }
    }

    async disconnect() {
        if (!this._connected) {
            throw new Error('Not connected')
        }

        this.ws?.close()

        this.ws = null
        this.sid = null

        if (this.client) {
            this.options.accessToken = null
            this.uid = null
        }

        this._connected = false
    }

    requestRecentChat(count: number = 50) {
        if (!this._connected) {
            throw new Error('Not connected')
        }

        this.ws.send(JSON.stringify({
            bdy: {recentMessageCount: count},
            cmd: ChatCmd.REQUEST_RECENT_CHAT,
            sid: this.sid,
            tid: 2,
            ...this.defaults
        }))
    }

    sendChat(message: string) {
        if (!this._connected) {
            throw new Error('Not connected')
        }

        if (!this.uid) {
            throw new Error('Not logged in')
        }

        const extras = {
            chatType: "STREAMING",
            emojis: "",
            osType: "PC",
            streamingChannelId: this.options.chatChannelId
        }

        this.ws.send(JSON.stringify({
            bdy: {
                extras: JSON.stringify(extras),
                msg: message,
                msgTime: Date.now(),
                msgTypeCode: ChatType.TEXT
            },
            retry: false,
            cmd: ChatCmd.SEND_CHAT,
            sid: this.sid,
            tid: 3,
            ...this.defaults
        }))
    }

    emit(event: string, data: any) {
        if (this.handlers[event]) {
            for (const handler of this.handlers[event]) {
                handler(data)
            }
        }
    }

    on<T extends keyof Events>(event: T, handler: (data: Events[typeof event]) => void) {
        const e = event as string
        this.handlers[e] = this.handlers[e] || []
        this.handlers[e].push(handler)
    }

    private async handleMessage(data: MessageEvent) {
        const json = JSON.parse(data.data as string)
        const body = json['bdy']

        switch (json.cmd) {
            case ChatCmd.CONNECTED:
                this._connected = true
                this.sid = body['sid']
                if (this.isReconnect) {
                    this.emit('reconnect', this.options.chatChannelId)
                    this.isReconnect = false
                } else {
                    this.emit('connect', null)
                }
                break

            case ChatCmd.PING:
                this.ws.send(JSON.stringify({
                    cmd: ChatCmd.PONG,
                    ver: "2"
                }))
                break

            case ChatCmd.CHAT:
            case ChatCmd.RECENT_CHAT:
            case ChatCmd.DONATION:
                const isRecent = json.cmd == ChatCmd.RECENT_CHAT
                const chats = body['messageList'] || body
                const notice = body['notice']

                if (notice) {
                    this.emit('notice', this.parseChat(notice, isRecent))
                }

                for (const chat of chats) {
                    const type = chat['msgTypeCode'] || chat['messageTypeCode'] || ''
                    const parsed = this.parseChat(chat, isRecent)

                    switch (type) {
                        case ChatType.TEXT:
                            this.emit('chat', parsed)
                            break
                        case ChatType.DONATION:
                            this.emit('donation', parsed)
                            break
                        case ChatType.SYSTEM_MESSAGE:
                            this.emit('systemMessage', parsed)
                            break
                    }
                }

                break

            case ChatCmd.NOTICE:
                this.emit('notice', this.parseChat(body))
                break

            case ChatCmd.BLIND:
                this.emit('blind', body)

            // case ChatCmd.PENALTY:
            // case ChatCmd.EVENT:
        }

        this.emit('raw', json)

        if (json.cmd != ChatCmd.PONG) {
            this.startPingTimer()
        }
    }

    private parseChat(chat: any, isRecent: boolean = false) {
        const profile = JSON.parse(chat['profile'])
        const extras = chat['extras'] ? JSON.parse(chat['extras']) : null

        const message = chat['msg'] || chat['content']
        const memberCount = chat['mbrCnt'] || chat['memberCount']
        const time = chat['msgTime'] || chat['messageTime']

        const hidden = (chat['msgStatusType'] || chat['messageStatusType']) == "HIDDEN"

        const parsed = {
            profile,
            extras,
            hidden,
            message,
            time,
            isRecent
        }

        if (memberCount) {
            parsed['memberCount'] = memberCount
        }

        return parsed
    }

    private startPolling() {
        if (!this.options.pollInterval || this.pollIntervalId) return

        this.pollIntervalId = setInterval(async () => {
            const status = await this.client.live.status(this.options.channelId)

            if (status.chatChannelId != this.options.chatChannelId) {
                this.options.chatChannelId = status.chatChannelId
                this.isReconnect = true

                await this.disconnect()
                await this.connect()
            }
        }, this.options.pollInterval)
    }

    private stopPolling() {
        if (this.pollIntervalId) {
            clearInterval(this.pollIntervalId)
        }

        this.pollIntervalId = null
    }

    private startPingTimer() {
        if (this.pingTimeoutId) {
            clearTimeout(this.pingTimeoutId)
        }

        this.pingTimeoutId = setTimeout(() => this.sendPing(), 20000)
    }

    private stopPingTimer() {
        if (this.pingTimeoutId) {
            clearTimeout(this.pingTimeoutId)
        }

        this.pingTimeoutId = null
    }

    private sendPing() {
        this.ws.send(JSON.stringify({
            cmd: ChatCmd.PING,
            ver: "2"
        }))

        this.pingTimeoutId = setTimeout(() => this.sendPing(), 20000)
    }
}