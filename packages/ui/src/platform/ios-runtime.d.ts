export declare const DEFAULT_ELIZA_CLOUD_BASE = "https://www.elizacloud.ai";
export type IosRuntimeMode =
  | "remote-mac"
  | "cloud"
  | "cloud-hybrid"
  | "local"
  | "tunnel-to-mobile";
export interface IosRuntimeConfig {
  mode: IosRuntimeMode;
  fullBun: boolean;
  apiBase?: string;
  apiToken?: string;
  cloudApiBase: string;
  deviceBridgeUrl?: string;
  deviceBridgeToken?: string;
  /**
   * Relay endpoint the phone dials to expose its on-device agent for an
   * external Mac client to reach. Only used in `tunnel-to-mobile` mode.
   * The phone-side `MobileAgentBridge` Capacitor plugin opens a long-
   * running outbound connection to this URL; Eliza Cloud (or another
   * configured relay) bridges traffic between this connection and a
   * Mac-side `TunnelToMobileClient` over the user's authenticated
   * session.
   */
  tunnelRelayUrl?: string;
  /**
   * Per-pairing token used to authorize the inbound tunnel. Distinct
   * from the cloud auth token because the relay should not need full
   * cloud credentials to authorize a single device pairing.
   */
  tunnelPairingToken?: string;
}
type RuntimeEnv = Record<string, string | boolean | undefined>;
export declare function resolveCloudApiBase(env: RuntimeEnv): string;
export declare function apiBaseToDeviceBridgeUrl(apiBase: string): string;
export declare function resolveIosRuntimeConfig(
  env: RuntimeEnv,
): IosRuntimeConfig;
//# sourceMappingURL=ios-runtime.d.ts.map
