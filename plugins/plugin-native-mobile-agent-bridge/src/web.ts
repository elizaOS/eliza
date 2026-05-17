import { WebPlugin } from "@capacitor/core";
import type {
  MobileAgentBridgePlugin,
  MobileAgentBridgeStartOptions,
  MobileAgentTunnelStatus,
} from "./definitions";

/**
 * Web fallback for the MobileAgentBridge.
 *
 * Browsers and Electrobun shells cannot host the on-device agent that
 * the inbound tunnel proxies traffic into. We surface a stable "idle"
 * status and reject `startInboundTunnel` so callers see an honest
 * failure mode rather than a silent no-op.
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
    this.status = {
      state: "error",
      relayUrl: options.relayUrl,
      deviceId: options.deviceId,
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
