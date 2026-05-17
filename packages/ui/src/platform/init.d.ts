/** Platform detection and initialization utilities. */
export { userAgentHasElizaOSMarker } from "./aosp-user-agent";
export declare const platform: string;
export declare const isNative: boolean;
export declare const isIOS: boolean;
export declare const isAndroid: boolean;
export declare function isDesktopPlatform(): boolean;
/**
 * True when the APK is running on the AOSP ElizaOS variant (the system
 * app on a Eliza-branded device), as opposed to the same APK installed
 * on a stock Android phone from Play Store.
 *
 * Detection: `MainActivity.applyElizaOSUserAgentSuffix` appends
 * `ElizaOS/<tag>` to the WebView user-agent when `ro.elizaos.product`
 * is set by the AOSP product makefile (vendor/eliza/eliza_common.mk).
 * Stock Android leaves the user-agent untouched.
 *
 * Used by `RuntimeGate` and the Android boot pre-seed to decide whether
 * the "Choose your setup" picker is bypassed (ElizaOS — the device IS
 * the agent) or rendered (vanilla APK — the user picks Cloud / Remote /
 * Local).
 */
export declare function isElizaOS(): boolean;
/** True when the runtime can spin up a local agent — desktop or dev server. */
export declare function canRunLocal(): boolean;
/**
 * True when the platform might host a local agent that the UI can reach over
 * the app. Used to decide whether the RuntimeGate's "Local Agent" tile
 * should run a liveness probe before being shown. Desktop and dev mode
 * always qualify; Android qualifies because `ElizaAgentService` starts the
 * bundled loopback agent; iOS qualifies because the same route shape is
 * carried over in-process ITTP/Capacitor IPC, not a TCP listener.
 */
export declare function canHostLocalAgent(): boolean;
export declare function isWebPlatform(): boolean;
export interface ShareTargetFile {
    name: string;
    path?: string;
}
export interface ShareTargetPayload {
    source?: string;
    title?: string;
    text?: string;
    url?: string;
    files?: ShareTargetFile[];
}
declare global {
    interface Window {
        __ELIZAOS_SHARE_QUEUE__?: ShareTargetPayload[];
    }
}
export declare function dispatchShareTarget(payload: ShareTargetPayload, dispatchEvent: (name: string, detail: unknown) => void, eventName: string): void;
export interface DeepLinkHandlers {
    onChat?: () => void;
    onSettings?: () => void;
    onConnect?: (gatewayUrl: string) => void;
    onShare?: (payload: ShareTargetPayload) => void;
    onUnknown?: (path: string) => void;
}
export declare function handleDeepLink(url: string, protocol: string, handlers: DeepLinkHandlers): void;
export declare function setupPlatformStyles(): void;
export declare function isPopoutWindow(): boolean;
export declare function injectPopoutApiBase(): void;
//# sourceMappingURL=init.d.ts.map