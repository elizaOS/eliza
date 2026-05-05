/**
 * Type definitions for the @elizaos/capacitor-wifi bridge.
 *
 * The native side is implemented in Kotlin under
 * android/src/main/java/ai/eliza/plugins/wifi/WiFiPlugin.kt and is registered
 * with Capacitor as `ElizaWiFi`. The web fallback in `./web.ts` resolves
 * with empty data and a warning so type-only consumers compile cleanly.
 */

/** Information about a single Wi-Fi network (scan result or active connection). */
export interface WiFiNetwork {
  /** Service Set Identifier — display name of the network. May be empty when hidden. */
  ssid: string;
  /** BSSID — MAC of the access point. */
  bssid: string;
  /** Signal strength in dBm (typical range -30 strongest to -90 weakest). */
  rssi: number;
  /** Channel frequency in MHz (e.g. 2412, 5180). */
  frequency: number;
  /**
   * Capability descriptor reported by `WifiManager.scanResults` (e.g.
   * "[WPA2-PSK-CCMP][ESS]"). Empty for the active connection on Android,
   * which does not expose capabilities for the connected network.
   */
  capabilities: string;
  /** Whether the network requires a password / key. */
  secured: boolean;
}

/** Optional filters/tuning passed to `listAvailableNetworks`. */
export interface ListNetworksOptions {
  /**
   * If a fresh scan was completed within `maxAge` milliseconds, reuse those
   * results instead of triggering a new `startScan`. Defaults to 30000.
   */
  maxAge?: number;
  /** Cap the number of networks returned (after de-duplication by SSID). */
  limit?: number;
}

/** Parameters for `connectToNetwork`. */
export interface ConnectOptions {
  /** Target SSID. Required. */
  ssid: string;
  /** Password / passphrase. Omit for open networks. */
  password?: string;
  /** Whether the SSID is hidden / not broadcast. Defaults to false. */
  hidden?: boolean;
}

/** Result returned by `getWifiState`. */
export interface WifiStateResult {
  /** Whether the Wi-Fi radio is enabled. */
  enabled: boolean;
  /** Whether a network is currently connected. */
  connected: boolean;
  /** Signal strength of the active connection in dBm, when connected. */
  rssi: number | null;
}

/** Result returned by `getConnectedNetwork`. */
export interface ConnectedNetworkResult {
  /** The active connection details, or null when not connected. */
  network: WiFiNetwork | null;
}

/** Result returned by `listAvailableNetworks`. */
export interface ListNetworksResult {
  networks: WiFiNetwork[];
}

/** Result returned by `connectToNetwork` and `disconnectFromNetwork`. */
export interface ConnectResult {
  success: boolean;
  /** Optional human-readable message, populated on failure. */
  message?: string;
}

/** Public Capacitor plugin contract — implemented natively on Android, stubbed on web. */
export interface WiFiPlugin {
  /** Read radio + active connection state. */
  getWifiState(): Promise<WifiStateResult>;
  /** Read active connection details. */
  getConnectedNetwork(): Promise<ConnectedNetworkResult>;
  /** Trigger a scan (or reuse a recent one) and return nearby networks. */
  listAvailableNetworks(
    options?: ListNetworksOptions,
  ): Promise<ListNetworksResult>;
  /** Best-effort connect using the appropriate per-API path. */
  connectToNetwork(options: ConnectOptions): Promise<ConnectResult>;
  /** Disconnect the currently connected network. */
  disconnectFromNetwork(): Promise<ConnectResult>;
}
