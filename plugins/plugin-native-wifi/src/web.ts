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

function normalizeListOptions(options?: ListNetworksOptions): void {
  if (options?.maxAge !== undefined) {
    if (
      typeof options.maxAge !== "number" ||
      !Number.isFinite(options.maxAge) ||
      options.maxAge < 0
    ) {
      throw new Error("maxAge must be a non-negative finite number");
    }
  }
  if (options?.limit !== undefined) {
    if (
      typeof options.limit !== "number" ||
      !Number.isFinite(options.limit) ||
      options.limit < 0
    ) {
      throw new Error("limit must be a non-negative finite number");
    }
  }
}

function validateConnectOptions(options: ConnectOptions): void {
  const ssid = typeof options?.ssid === "string" ? options.ssid.trim() : "";
  if (!ssid) {
    throw new Error("ssid is required");
  }
  if (options?.password !== undefined && typeof options.password !== "string") {
    throw new Error("password must be a string");
  }
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
    options?: ListNetworksOptions,
  ): Promise<ListNetworksResult> {
    normalizeListOptions(options);
    warnOnce();
    return { networks: [] };
  }

  async connectToNetwork(options: ConnectOptions): Promise<ConnectResult> {
    validateConnectOptions(options);
    warnOnce();
    return { success: false, message: UNAVAILABLE_MESSAGE };
  }

  async disconnectFromNetwork(): Promise<ConnectResult> {
    warnOnce();
    return { success: false, message: UNAVAILABLE_MESSAGE };
  }
}
