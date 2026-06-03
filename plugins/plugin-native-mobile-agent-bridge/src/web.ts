import { WebPlugin } from "@capacitor/core";
import type {
  MobileAgentBridgePlugin,
  MobileAgentBridgeStartOptions,
  MobileAgentTunnelStatus,
} from "./definitions";

function assertRelayUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("relayUrl must be a non-empty URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("relayUrl must be a valid URL");
  }
  if (
    parsed.protocol !== "wss:" &&
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:"
  ) {
    throw new Error("relayUrl protocol is not allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("relayUrl must not contain embedded credentials");
  }
  return parsed.toString();
}

function assertDeviceId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("deviceId must be a non-empty string");
  }
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(normalized)) {
    throw new Error("deviceId contains invalid characters");
  }
  return normalized;
}

/**
 * Web fallback for the MobileAgentBridge.
 *
 * Browsers and Electrobun shells cannot host the on-device agent that
 * the inbound tunnel proxies traffic into. We surface a stable "idle"
 * status and reject `startInboundTunnel` so callers see an honest
 * failure mode rather than a silent success.
 */
export class MobileAgentBridgeWeb extends WebPlugin implements MobileAgentBridgePlugin {
  private status: MobileAgentTunnelStatus = {
    state: "idle",
    relayUrl: null,
    deviceId: null,
    lastError: null,
  };

  async startInboundTunnel(
    options: MobileAgentBridgeStartOptions,
  ): Promise<MobileAgentTunnelStatus> {
    const relayUrl = assertRelayUrl(options.relayUrl);
    const deviceId = assertDeviceId(options.deviceId);
    this.status = {
      state: "error",
      relayUrl,
      deviceId,
      lastError: "MobileAgentBridge.startInboundTunnel is only available on iOS and Android.",
    };
    this.notifyListeners("stateChange", {
      state: "error",
      reason: this.status.lastError ?? undefined,
    });
    return this.status;
  }

  async stopInboundTunnel(): Promise<void> {
    if (this.status.state === "idle") return;
    this.status = {
      state: "idle",
      relayUrl: null,
      deviceId: null,
      lastError: null,
    };
    this.notifyListeners("stateChange", { state: "idle" });
  }

  async getTunnelStatus(): Promise<MobileAgentTunnelStatus> {
    return this.status;
  }
}
