/**
 * Gateway Plugin for Electron
 *
 * Provides WebSocket connection to Gateway servers and mDNS/Bonjour discovery
 * for local network gateway discovery on macOS, Windows, and Linux.
 *
 * Discovery uses the dns-sd/mdns protocol via Electron's Node.js environment.
 * WebSocket connections follow the same RPC framing as the web implementation.
 */
const isJsonObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const getString = (value) => typeof value === "string" ? value : undefined;
const getNumber = (value) => typeof value === "number" ? value : undefined;
const getBoolean = (value) => typeof value === "boolean" ? value : undefined;
const toStringArray = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
const parseGatewayError = (value) => {
    if (!value || !isJsonObject(value))
        return undefined;
    const code = getString(value.code);
    const message = getString(value.message);
    if (!code || !message)
        return undefined;
    return {
        code,
        message,
        details: value.details,
    };
};
function generateUUID() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
/**
 * Gateway Plugin implementation for Electron
 */
export class GatewayElectron {
    constructor() {
        this.ws = null;
        this.pending = new Map();
        this.options = null;
        this.sessionId = null;
        this.protocol = null;
        this.role = null;
        this.scopes = [];
        this.methods = [];
        this.events = [];
        this.lastSeq = null;
        this.reconnectTimer = null;
        this.backoffMs = 800;
        this.closed = false;
        this.connectResolve = null;
        this.connectReject = null;
        this.listeners = [];
        this.discoveredGateways = new Map();
        this.isDiscovering = false;
        this.discoveryIPCHandler = null;
    }
    // MARK: - Connection Methods
    async connect(options) {
        if (this.ws) {
            this.closed = true;
            this.ws.close();
            this.ws = null;
        }
        this.options = options;
        this.closed = false;
        this.backoffMs = 800;
        return new Promise((resolve, reject) => {
            this.connectResolve = resolve;
            this.connectReject = reject;
            this.establishConnection();
        });
    }
    establishConnection() {
        if (this.closed || !this.options) {
            return;
        }
        this.notifyStateChange("connecting");
        this.ws = new WebSocket(this.options.url);
        this.ws.addEventListener("open", () => {
            this.sendConnectFrame();
        });
        this.ws.addEventListener("message", (event) => {
            this.handleMessage(String(event.data));
        });
        this.ws.addEventListener("close", (event) => {
            const reason = event.reason || "Connection closed";
            this.handleClose(event.code, reason);
        });
        this.ws.addEventListener("error", () => {
            // Error handler - close will follow
        });
    }
    sendConnectFrame() {
        if (!this.ws || !this.options || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        const auth = {};
        if (this.options.token) {
            auth.token = this.options.token;
        }
        if (this.options.password) {
            auth.password = this.options.password;
        }
        const params = {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
                id: this.options.clientName || "milaidy-capacitor",
                version: this.options.clientVersion || "1.0.0",
                platform: this.getPlatform(),
                mode: "ui",
            },
            role: this.options.role || "operator",
            scopes: this.options.scopes || ["operator.admin"],
            caps: [],
            auth,
        };
        const frame = {
            type: "req",
            id: generateUUID(),
            method: "connect",
            params,
        };
        this.ws.send(JSON.stringify(frame));
        // Set up timeout for connect response
        const timeout = setTimeout(() => {
            if (this.connectReject) {
                this.connectReject(new Error("Connection timeout"));
                this.connectReject = null;
                this.connectResolve = null;
            }
        }, 30000);
        this.pending.set(frame.id, {
            resolve: (result) => {
                clearTimeout(timeout);
                if (result.ok && result.payload && isJsonObject(result.payload)) {
                    this.handleHelloOk(result.payload);
                }
                else if (this.connectReject) {
                    this.connectReject(new Error(result.error?.message || "Connection failed"));
                }
                this.connectReject = null;
                this.connectResolve = null;
            },
            reject: (error) => {
                clearTimeout(timeout);
                if (this.connectReject) {
                    this.connectReject(error);
                }
                this.connectReject = null;
                this.connectResolve = null;
            },
            timeout,
        });
    }
    handleHelloOk(hello) {
        const protocol = getNumber(hello.protocol);
        const auth = isJsonObject(hello.auth) ? hello.auth : null;
        const features = isJsonObject(hello.features) ? hello.features : null;
        this.sessionId = generateUUID();
        this.protocol = protocol ?? null;
        this.role = getString(auth?.role) || this.options?.role || "operator";
        this.scopes = toStringArray(auth?.scopes);
        this.methods = toStringArray(features?.methods);
        this.events = toStringArray(features?.events);
        this.backoffMs = 800;
        this.notifyStateChange("connected");
        if (this.connectResolve) {
            this.connectResolve({
                connected: true,
                sessionId: this.sessionId,
                protocol: this.protocol ?? undefined,
                methods: this.methods,
                events: this.events,
                role: this.role ?? undefined,
                scopes: this.scopes,
            });
        }
    }
    handleMessage(raw) {
        let parsedValue;
        try {
            parsedValue = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (!isJsonObject(parsedValue)) {
            return;
        }
        const frameType = getString(parsedValue.type);
        if (!frameType) {
            return;
        }
        if (frameType === "res") {
            const id = getString(parsedValue.id);
            if (!id)
                return;
            const pending = this.pending.get(id);
            if (pending) {
                this.pending.delete(id);
                clearTimeout(pending.timeout);
                pending.resolve({
                    ok: getBoolean(parsedValue.ok) ?? false,
                    payload: parsedValue.payload,
                    error: parseGatewayError(parsedValue.error),
                });
            }
            return;
        }
        if (frameType === "event") {
            const event = getString(parsedValue.event);
            if (!event)
                return;
            const payload = parsedValue.payload;
            const seq = getNumber(parsedValue.seq);
            if (seq !== undefined && this.lastSeq !== null && seq > this.lastSeq + 1) {
                console.warn(`[Gateway] Event sequence gap: expected ${this.lastSeq + 1}, got ${seq}`);
            }
            if (seq !== undefined) {
                this.lastSeq = seq;
            }
            this.notifyListeners("gatewayEvent", {
                event,
                payload,
                seq,
            });
            return;
        }
    }
    handleClose(code, reason) {
        this.ws = null;
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(`Connection closed: ${reason}`));
            this.pending.delete(id);
        }
        if (this.closed) {
            this.notifyStateChange("disconnected", reason);
            return;
        }
        this.notifyStateChange("reconnecting", reason);
        this.notifyListeners("error", {
            message: `Connection lost: ${reason}`,
            code: String(code),
            willRetry: true,
        });
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.closed || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.backoffMs = Math.min(this.backoffMs * 1.7, 15000);
            this.establishConnection();
        }, this.backoffMs);
    }
    notifyStateChange(state, reason) {
        this.notifyListeners("stateChange", {
            state,
            reason,
        });
    }
    getPlatform() {
        if (typeof navigator !== "undefined") {
            return navigator.platform || "electron";
        }
        return "electron";
    }
    async disconnect() {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close(1000, "Client disconnect");
            this.ws = null;
        }
        this.sessionId = null;
        this.protocol = null;
        this.role = null;
        this.notifyStateChange("disconnected", "Client disconnect");
    }
    async isConnected() {
        return {
            connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
        };
    }
    async send(options) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return {
                ok: false,
                error: {
                    code: "NOT_CONNECTED",
                    message: "Not connected to gateway",
                },
            };
        }
        const id = generateUUID();
        const frame = {
            type: "req",
            id,
            method: options.method,
            params: options.params ?? {},
        };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                resolve({
                    ok: false,
                    error: {
                        code: "TIMEOUT",
                        message: "Request timed out",
                    },
                });
            }, 60000);
            this.pending.set(id, {
                resolve,
                reject,
                timeout,
            });
            this.ws?.send(JSON.stringify(frame));
        });
    }
    async getConnectionInfo() {
        return {
            url: this.options?.url || null,
            sessionId: this.sessionId,
            protocol: this.protocol,
            role: this.role,
        };
    }
    // MARK: - Discovery Methods
    async startDiscovery(options) {
        if (this.isDiscovering) {
            return {
                gateways: Array.from(this.discoveredGateways.values()),
                status: "Already discovering",
            };
        }
        if (window.electron?.ipcRenderer) {
            try {
                this.isDiscovering = true;
                this.discoveredGateways.clear();
                this.discoveryIPCHandler = (event) => {
                    this.handleDiscoveryEvent(event);
                };
                window.electron.ipcRenderer.on("gateway:discovery", this.discoveryIPCHandler);
                await window.electron.ipcRenderer.invoke("gateway:startDiscovery", {
                    wideAreaDomain: options?.wideAreaDomain,
                    timeout: options?.timeout || 30000,
                });
                return {
                    gateways: [],
                    status: "Discovery started",
                };
            }
            catch (error) {
                this.isDiscovering = false;
                if (this.discoveryIPCHandler && window.electron?.ipcRenderer) {
                    window.electron.ipcRenderer.removeListener("gateway:discovery", this.discoveryIPCHandler);
                    this.discoveryIPCHandler = null;
                }
                console.warn("[Gateway] Native discovery failed, using fallback:", error);
            }
        }
        console.warn("[Gateway] mDNS discovery not available - Electron IPC bridge not configured");
        return {
            gateways: [],
            status: "Discovery not available on this platform",
        };
    }
    async stopDiscovery() {
        this.isDiscovering = false;
        if (window.electron?.ipcRenderer) {
            if (this.discoveryIPCHandler) {
                window.electron.ipcRenderer.removeListener("gateway:discovery", this.discoveryIPCHandler);
                this.discoveryIPCHandler = null;
            }
            try {
                await window.electron.ipcRenderer.invoke("gateway:stopDiscovery");
            }
            catch {
                // Ignore errors when stopping
            }
        }
    }
    async getDiscoveredGateways() {
        return {
            gateways: Array.from(this.discoveredGateways.values()),
            status: this.isDiscovering ? "Discovering" : "Idle",
        };
    }
    handleDiscoveryEvent(event) {
        switch (event.type) {
            case "found":
            case "updated":
                this.discoveredGateways.set(event.gateway.stableId, event.gateway);
                break;
            case "lost":
                this.discoveredGateways.delete(event.gateway.stableId);
                break;
        }
        this.notifyListeners("discovery", event);
    }
    // MARK: - Event Listeners
    notifyListeners(eventName, data) {
        for (const listener of this.listeners) {
            if (listener.eventName === eventName) {
                listener.callback(data);
            }
        }
    }
    async addListener(eventName, listenerFunc) {
        const entry = { eventName, callback: listenerFunc };
        this.listeners.push(entry);
        return {
            remove: async () => {
                const idx = this.listeners.indexOf(entry);
                if (idx >= 0) {
                    this.listeners.splice(idx, 1);
                }
            },
        };
    }
    async removeAllListeners() {
        this.listeners = [];
    }
}
// Export the plugin instance
export const Gateway = new GatewayElectron();
