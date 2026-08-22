/**
 * Exposes the retained LifeOps Signal API boundary as explicitly unavailable
 * until elizaOS owns a legal, bundled, in-process Signal transport.
 */
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalInboundMessage,
} from "@elizaos/shared";
import { fail } from "../service-normalize.js";
import { normalizeOptionalConnectorSide } from "../service-normalize-connector.js";

const SIGNAL_UNSUPPORTED_MESSAGE =
  "Signal is unavailable: elizaOS has no legal, bundled, in-process Signal transport, and external Signal apps or daemons are not supported.";

export class SignalDomain {
  lifeOpsSignalServiceConnected(): boolean {
    return false;
  }

  lifeOpsSignalServiceRegistered(): boolean {
    return false;
  }

  async getSignalConnectorStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsSignalConnectorStatus> {
    const resolvedSide =
      normalizeOptionalConnectorSide(side, "side") ?? "owner";
    return {
      provider: "signal",
      side: resolvedSide,
      connected: false,
      inbound: false,
      reason: "disconnected",
      identity: null,
      grantedCapabilities: [],
      pairing: null,
      grant: null,
      degradations: [
        {
          axis: "transport-offline",
          code: "signal_direct_transport_unavailable",
          message: SIGNAL_UNSUPPORTED_MESSAGE,
          retryable: false,
        },
      ],
    };
  }

  async readSignalInbound(
    _limit = 25,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsSignalInboundMessage[]> {
    normalizeOptionalConnectorSide(side, "side");
    fail(501, SIGNAL_UNSUPPORTED_MESSAGE);
  }

  async sendSignalMessage(request: {
    side?: LifeOpsConnectorSide;
    recipient: string;
    text: string;
  }): Promise<{
    provider: "signal";
    side: LifeOpsConnectorSide;
    recipient: string;
    ok: true;
    timestamp: number;
  }> {
    normalizeOptionalConnectorSide(request.side, "side");
    if (!request.recipient.trim()) fail(400, "recipient is required");
    if (!request.text.trim()) fail(400, "text is required");
    fail(501, SIGNAL_UNSUPPORTED_MESSAGE);
  }
}
