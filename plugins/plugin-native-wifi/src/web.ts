import { WebPlugin } from "@capacitor/core";

import type {
  ConnectedNetworkResult,
  ConnectOptions,
  ConnectResult,
  ListNetworksOptions,
  ListNetworksResult,
  WiFiPlugin,
  WifiStateResult,
} from "./definitions";

const UNAVAILABLE_MESSAGE = "Wi-Fi controls are only available on Android.";

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(`[ElizaWiFi] ${UNAVAILABLE_MESSAGE}`);
}

/**
 * Web fallback — every method resolves with empty / disabled data so the
 * full TypeScript interface is satisfied without throwing during normal
 * desktop or browser dev sessions. `connectToNetwork` and
 * `disconnectFromNetwork` resolve with `{ success: false }` because there is
 * no meaningful action to take on the web side.
 */
export class WiFiWeb extends WebPlugin implements WiFiPlugin {
  async getWifiState(): Promise<WifiStateResult> {
    warnOnce();
    return { enabled: false, connected: false, rssi: null };
  }

  async getConnectedNetwork(): Promise<ConnectedNetworkResult> {
    warnOnce();
    return { network: null };
  }

  async listAvailableNetworks(
    _options?: ListNetworksOptions,
  ): Promise<ListNetworksResult> {
    warnOnce();
    return { networks: [] };
  }

  async connectToNetwork(_options: ConnectOptions): Promise<ConnectResult> {
    warnOnce();
    return { success: false, message: UNAVAILABLE_MESSAGE };
  }

  async disconnectFromNetwork(): Promise<ConnectResult> {
    warnOnce();
    return { success: false, message: UNAVAILABLE_MESSAGE };
  }
}
