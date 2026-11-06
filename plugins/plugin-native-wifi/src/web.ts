import { WebPlugin } from "@capacitor/core";

import type {
  ApprovedJoinResult,
  ConnectedNetworkResult,
  ConnectivityResult,
  ConnectOptions,
  ConnectResult,
  ListNetworksOptions,
  ListNetworksResult,
  WiFiCapabilities,
  WiFiPermissionStatus,
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
  if (
    options?.joinable !== undefined &&
    typeof options.joinable !== "boolean"
  ) {
    throw new Error("joinable must be a boolean");
  }
  if (options?.timeout !== undefined) {
    if (
      typeof options.timeout !== "number" ||
      !Number.isInteger(options.timeout) ||
      options.timeout < 0 ||
      options.timeout > 30000
    ) {
      throw new Error("timeout must be an integer from 0 to 30000");
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
  if (options?.password !== undefined && typeof options.password !== "string") {
    throw new Error("password must be a string");
  }
  if (
    options?.security !== undefined &&
    !JOINABLE_SECURITY.has(options.security)
  ) {
    throw new Error("security must be open, owe, wpa2 or wpa3");
  }
}

const JOINABLE_SECURITY = new Set<unknown>(["open", "owe", "wpa2", "wpa3"]);

/**
 * Web fallback — every method resolves with empty / disabled data so the
 * full TypeScript interface is satisfied without throwing during normal
 * desktop or browser dev sessions. `connectToNetwork` and
 * `disconnectFromNetwork` resolve with `{ success: false }` because there is
 * no meaningful action to take on the web side. `getConnectivity` and
 * `addNetworkWithApproval` reject as unavailable: an empty result would
 * misreport the browser's Internet state. `getCapabilities` reports that no
 * join path exists; the permission methods and `openInternetPanel` reject as
 * unavailable.
 */
export class WiFiWeb extends WebPlugin implements WiFiPlugin {
  async checkPermissions(): Promise<WiFiPermissionStatus> {
    throw this.unavailable(UNAVAILABLE_MESSAGE);
  }

  async requestPermissions(): Promise<WiFiPermissionStatus> {
    throw this.unavailable(UNAVAILABLE_MESSAGE);
  }

  async getCapabilities(): Promise<WiFiCapabilities> {
    return { sdk: 0, approvedJoin: false, internetPanel: false };
  }

  async openInternetPanel(): Promise<void> {
    throw this.unavailable(UNAVAILABLE_MESSAGE);
  }

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

  async getConnectivity(): Promise<ConnectivityResult> {
    throw this.unavailable(UNAVAILABLE_MESSAGE);
  }

  async addNetworkWithApproval(
    options: ConnectOptions,
  ): Promise<ApprovedJoinResult> {
    validateConnectOptions(options);
    throw this.unavailable(UNAVAILABLE_MESSAGE);
  }
}
