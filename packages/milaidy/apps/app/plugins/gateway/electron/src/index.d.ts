/**
 * Gateway Plugin for Electron
 *
 * Provides WebSocket connection to Gateway servers and mDNS/Bonjour discovery
 * for local network gateway discovery on macOS, Windows, and Linux.
 *
 * Discovery uses the dns-sd/mdns protocol via Electron's Node.js environment.
 * WebSocket connections follow the same RPC framing as the web implementation.
 */
import type { PluginListenerHandle } from "@capacitor/core";
import type { GatewayPlugin, GatewayConnectOptions, GatewayConnectResult, GatewayDiscoveryOptions, GatewayDiscoveryResult, GatewayDiscoveryEvent, GatewaySendOptions, GatewaySendResult, GatewayEvent, GatewayStateEvent, GatewayErrorEvent } from "../../src/definitions";
type IpcPrimitive = string | number | boolean | null | undefined;
type IpcObject = {
    [key: string]: IpcValue;
};
type IpcValue = IpcPrimitive | IpcObject | IpcValue[] | ArrayBuffer | Float32Array | Uint8Array;
type IpcListener = (...args: IpcValue[]) => void;
interface ElectronAPI {
    ipcRenderer: {
        invoke(channel: string, ...args: IpcValue[]): Promise<IpcValue>;
        on(channel: string, listener: IpcListener): void;
        removeListener(channel: string, listener: IpcListener): void;
    };
}
declare global {
    interface Window {
        electron?: ElectronAPI;
    }
}
/**
 * Gateway Plugin implementation for Electron
 */
export declare class GatewayElectron implements GatewayPlugin {
    private ws;
    private pending;
    private options;
    private sessionId;
    private protocol;
    private role;
    private scopes;
    private methods;
    private events;
    private lastSeq;
    private reconnectTimer;
    private backoffMs;
    private closed;
    private connectResolve;
    private connectReject;
    private listeners;
    private discoveredGateways;
    private isDiscovering;
    private discoveryIPCHandler;
    connect(options: GatewayConnectOptions): Promise<GatewayConnectResult>;
    private establishConnection;
    private sendConnectFrame;
    private handleHelloOk;
    private handleMessage;
    private handleClose;
    private scheduleReconnect;
    private notifyStateChange;
    private getPlatform;
    disconnect(): Promise<void>;
    isConnected(): Promise<{
        connected: boolean;
    }>;
    send(options: GatewaySendOptions): Promise<GatewaySendResult>;
    getConnectionInfo(): Promise<{
        url: string | null;
        sessionId: string | null;
        protocol: number | null;
        role: string | null;
    }>;
    startDiscovery(options?: GatewayDiscoveryOptions): Promise<GatewayDiscoveryResult>;
    stopDiscovery(): Promise<void>;
    getDiscoveredGateways(): Promise<GatewayDiscoveryResult>;
    private handleDiscoveryEvent;
    private notifyListeners;
    addListener(eventName: "gatewayEvent", listenerFunc: (event: GatewayEvent) => void): Promise<PluginListenerHandle>;
    addListener(eventName: "stateChange", listenerFunc: (event: GatewayStateEvent) => void): Promise<PluginListenerHandle>;
    addListener(eventName: "error", listenerFunc: (event: GatewayErrorEvent) => void): Promise<PluginListenerHandle>;
    addListener(eventName: "discovery", listenerFunc: (event: GatewayDiscoveryEvent) => void): Promise<PluginListenerHandle>;
    removeAllListeners(): Promise<void>;
}
export declare const Gateway: GatewayElectron;
export {};
