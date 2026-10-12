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
  // error-policy:J4 designed platform degrade — Wi-Fi is Android-only; on
  // web/desktop the fallback returns empty/disabled DTOs (not failed data) and
  // announces the unavailability once. No elizaOS logger is reachable in this
  // dependency-free Capacitor web plugin; console is the webview surface.
  console.warn(`[ElizaWiFi] ${UNAVAILABLE_MESSAGE}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeListOptions(options?: ListNetworksOptions): void {
  if (options === undefined) return;
  if (!isRecord(options)) {
    throw new Error("options must be an object");
  }
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
      !Number.isInteger(options.limit) ||
      options.limit < 0
    ) {
      throw new Error("limit must be a non-negative finite integer");
    }
  }
}

function validateConnectOptions(options: ConnectOptions): void {
  const ssid = typeof options?.ssid === "string" ? options.ssid.trim() : "";
  if (!ssid) {
    throw new Error("ssid is required");
  }
  // The Android bridge enforces the 802.11 SSID limit on the trimmed SSID
  // (WiFiConnectionRequests.suggest: 1 to 32 UTF-8 bytes). Without this check
  // the web fallback accepted over-long SSIDs that native rejects.
  if (new TextEncoder().encode(ssid).length > 32) {
    throw new Error("SSID must contain 1 to 32 UTF-8 bytes");
  }
  if (options?.password !== undefined && typeof options.password !== "string") {
    throw new Error("password must be a string");
  }
  // An empty password is an open network, as on native. A non-empty password
  // is a WPA2 passphrase: the Android bridge requires 8 to 63 printable ASCII
  // characters (codes 32 to 126) and rejects anything else before requesting
  // a connection.
  const password = options?.password;
  if (password) {
    const validPassphrase =
      password.length >= 8 &&
      password.length <= 63 &&
      [...password].every((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 32 && code <= 126;
      });
    if (!validPassphrase) {
      throw new Error(
        "WPA2 passphrase must contain 8 to 63 printable ASCII characters",
      );
    }
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
