import type { OnboardingServerTarget } from "./server-target";
export declare const MOBILE_RUNTIME_MODE_STORAGE_KEY =
  "eliza:mobile-runtime-mode";
/**
 * Constants describing the bundled mobile on-device agent endpoint.
 *
 * `MOBILE_LOCAL_AGENT_IPC_BASE` is the UI-facing identity for the bundled
 * local agent. Native transports resolve it through Capacitor instead of
 * letting WebView fetch open a socket. The loopback URL remains as the
 * Android service implementation detail used by the current native bridge
 * and simulator harness until the route kernel moves behind Binder/stdio IPC.
 */
export declare const MOBILE_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";
export declare const MOBILE_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
export declare const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
export declare const MOBILE_LOCAL_AGENT_SERVER_ID = "local:mobile";
export declare const MOBILE_LOCAL_AGENT_LABEL = "On-device agent";
export declare const MOBILE_LOCAL_AGENT_PORT = "31337";
export declare const ANDROID_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";
export declare const ANDROID_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
export declare const ANDROID_LOCAL_AGENT_SERVER_ID = "local:android";
export declare const ANDROID_LOCAL_AGENT_LABEL = "On-device agent";
export declare function isMobileLocalAgentIpcUrl(
  value: string | URL | null | undefined,
): boolean;
export declare function mobileLocalAgentPathFromUrl(
  value: string | URL | null | undefined,
): string | null;
export declare function isMobileLocalAgentUrl(
  value: string | URL | null | undefined,
): boolean;
export type MobileRuntimeMode =
  | "remote-mac"
  | "cloud"
  | "cloud-hybrid"
  | "local"
  | "tunnel-to-mobile";
export declare function normalizeMobileRuntimeMode(
  value: string | null | undefined,
): MobileRuntimeMode | null;
export declare function mobileRuntimeModeForServerTarget(
  target: OnboardingServerTarget,
): MobileRuntimeMode | null;
export declare function readPersistedMobileRuntimeMode(): MobileRuntimeMode | null;
export declare function isElizaCloudRuntimeLocked(): boolean;
export declare function persistMobileRuntimeModeForServerTarget(
  target: OnboardingServerTarget,
): void;
//# sourceMappingURL=mobile-runtime-mode.d.ts.map
