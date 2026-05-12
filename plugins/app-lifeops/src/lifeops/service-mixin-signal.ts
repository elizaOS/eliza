import {
  LIFEOPS_SIGNAL_CAPABILITIES,
  type LifeOpsConnectorDegradation,
  type LifeOpsConnectorSide,
  type LifeOpsSignalCapability,
  type LifeOpsSignalConnectorStatus,
  type LifeOpsSignalInboundMessage,
  type LifeOpsSignalPairingStatus,
  type StartLifeOpsSignalPairingResponse,
} from "@elizaos/shared";
import {
  readSignalRecentWithRuntimeService,
  sendSignalMessageWithRuntimeService,
} from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import { normalizeOptionalConnectorSide } from "./service-normalize-connector.js";

const FULL_SIGNAL_CAPABILITIES: LifeOpsSignalCapability[] = [
  ...LIFEOPS_SIGNAL_CAPABILITIES,
];

const SIGNAL_PLUGIN_SETUP_MESSAGE =
  "Signal is managed by @elizaos/plugin-signal. Configure and enable the Signal connector plugin; LifeOps no longer uses local Signal credentials.";

const SIGNAL_PAIRING_MIGRATED_MESSAGE =
  "Signal pairing has moved to @elizaos/plugin-signal. Use the Signal connector setup routes (/api/signal/pair, /api/signal/status, and /api/signal/disconnect); LifeOps no longer owns Signal device-link credentials.";

type SignalServiceRecentMessage = {
  id: string;
  roomId: string;
  channelId: string;
  roomName: string;
  speakerName: string;
  text: string;
  createdAt: number;
  isFromAgent: boolean;
  isGroup: boolean;
};

type SignalServiceLike = {
  getAccountNumber?: () => string | null;
  isConnected?: boolean;
  isServiceConnected?: () => boolean;
  getRecentMessages?: (
    limit?: number,
    accountId?: string,
  ) => Promise<SignalServiceRecentMessage[]>;
  sendMessage?: (
    recipient: string,
    text: string,
    options?: { accountId?: string; record?: boolean },
  ) => Promise<{ timestamp?: number }>;
};

function normalizeSignalCapabilities(
  capabilities: readonly string[] | null | undefined,
): LifeOpsSignalCapability[] {
  return (capabilities ?? []).filter(
    (candidate): candidate is LifeOpsSignalCapability =>
      candidate === "signal.read" || candidate === "signal.send",
  );
}

function getSignalService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): SignalServiceLike | null {
  const service = runtime.getService?.("signal") as SignalServiceLike | null;
  return service && typeof service === "object" ? service : null;
}

function signalServiceConnected(service: SignalServiceLike | null): boolean {
  return Boolean(
    service?.isConnected === true || service?.isServiceConnected?.() === true,
  );
}

function signalServiceCanRead(service: SignalServiceLike | null): boolean {
  return typeof service?.getRecentMessages === "function";
}

function signalServiceCanSend(service: SignalServiceLike | null): boolean {
  return typeof service?.sendMessage === "function";
}

function signalReadyCapabilities(args: {
  granted: readonly string[] | null | undefined;
  inboundReady: boolean;
  sendReady: boolean;
}): LifeOpsSignalCapability[] {
  return normalizeSignalCapabilities(args.granted).filter((capability) =>
    capability === "signal.read" ? args.inboundReady : args.sendReady,
  );
}

function signalStatusDegradations(args: {
  connected: boolean;
  grantedCapabilities: readonly LifeOpsSignalCapability[];
  inboundReady: boolean;
  sendReady: boolean;
}): LifeOpsConnectorDegradation[] {
  const degradations: LifeOpsConnectorDegradation[] = [];
  const granted = new Set(args.grantedCapabilities);
  if (!args.connected) {
    degradations.push({
      axis: "transport-offline",
      code: "signal_plugin_unavailable",
      message: SIGNAL_PLUGIN_SETUP_MESSAGE,
      retryable: true,
    });
  }
  if (args.connected && granted.has("signal.read") && !args.inboundReady) {
    degradations.push({
      axis: "transport-offline",
      code: "signal_plugin_inbound_unavailable",
      message:
        "Signal is connected, but @elizaos/plugin-signal does not expose an inbound read path.",
      retryable: true,
    });
  }
  if (args.connected && granted.has("signal.send") && !args.sendReady) {
    degradations.push({
      axis: "delivery-degraded",
      code: "signal_plugin_send_unavailable",
      message:
        "Signal is connected, but @elizaos/plugin-signal does not expose a send path.",
      retryable: true,
    });
  }
  return degradations;
}

function signalRuntimeMessageToLifeOps(
  entry: unknown,
): LifeOpsSignalInboundMessage {
  const record =
    entry && typeof entry === "object"
      ? (entry as Record<string, unknown>)
      : {};
  const isGroup = record.isGroup === true;
  const channelId =
    typeof record.channelId === "string" ? record.channelId : "";
  const roomId = typeof record.roomId === "string" ? record.roomId : channelId;
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now();
  return {
    id:
      typeof record.id === "string" ? record.id : `signal-runtime-${createdAt}`,
    roomId,
    channelId,
    threadId: channelId || roomId,
    roomName: typeof record.roomName === "string" ? record.roomName : "Signal",
    speakerName:
      typeof record.speakerName === "string" ? record.speakerName : "Signal",
    senderNumber: isGroup ? null : channelId || null,
    senderUuid: null,
    sourceDevice: null,
    groupId: isGroup ? channelId || null : null,
    groupType: null,
    text: typeof record.text === "string" ? record.text : "",
    createdAt,
    isInbound: record.isFromAgent !== true,
    isGroup,
  };
}

/** @internal */
export function withSignal<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsSignalServiceMixin extends Base {
    lifeOpsSignalServiceConnected(): boolean {
      return signalServiceConnected(getSignalService(this.runtime));
    }

    lifeOpsSignalServiceRegistered(): boolean {
      return Boolean(this.runtime.getService?.("signal"));
    }

    async getSignalConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsSignalConnectorStatus> {
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const signalService = getSignalService(this.runtime);
      const inboundReady = signalServiceCanRead(signalService);
      const sendReady = signalServiceCanSend(signalService);
      const connected =
        signalServiceConnected(signalService) || inboundReady || sendReady;
      const grantedCapabilities = connected ? FULL_SIGNAL_CAPABILITIES : [];
      const capabilities = signalReadyCapabilities({
        granted: grantedCapabilities,
        inboundReady,
        sendReady,
      });
      const phoneNumber = signalService?.getAccountNumber?.() ?? null;
      const degradations = signalStatusDegradations({
        connected,
        grantedCapabilities,
        inboundReady,
        sendReady,
      });

      return {
        provider: "signal",
        side: resolvedSide,
        connected,
        inbound: connected && capabilities.includes("signal.read"),
        reason: connected ? "connected" : "disconnected",
        identity: phoneNumber ? { phoneNumber } : null,
        grantedCapabilities: capabilities,
        pairing: null,
        grant: null,
        ...(degradations.length > 0 ? { degradations } : {}),
      };
    }

    async startSignalPairing(
      _side?: LifeOpsConnectorSide,
    ): Promise<StartLifeOpsSignalPairingResponse> {
      fail(410, SIGNAL_PAIRING_MIGRATED_MESSAGE);
    }

    async getSignalPairingStatus(
      sessionId: string,
    ): Promise<LifeOpsSignalPairingStatus> {
      if (!sessionId) {
        fail(400, "sessionId is required");
      }
      fail(410, SIGNAL_PAIRING_MIGRATED_MESSAGE);
    }

    stopSignalPairing(
      _side?: LifeOpsConnectorSide,
    ): LifeOpsSignalPairingStatus {
      fail(410, SIGNAL_PAIRING_MIGRATED_MESSAGE);
    }

    async disconnectSignal(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsSignalConnectorStatus> {
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      return {
        provider: "signal",
        side: resolvedSide,
        connected: false,
        reason: "disconnected",
        identity: null,
        grantedCapabilities: [],
        inbound: false,
        pairing: null,
        grant: null,
      };
    }

    async readSignalInbound(
      limit = 25,
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsSignalInboundMessage[]> {
      const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const status = await this.getSignalConnectorStatus(resolvedSide);
      const delegated = await readSignalRecentWithRuntimeService({
        runtime: this.runtime,
        grant: status.grant,
        limit: clampedLimit,
      });
      if (delegated.status === "handled") {
        return delegated.value.map(signalRuntimeMessageToLifeOps);
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_failed",
          delegated.reason,
          {
            provider: "signal",
            operation: "message.read",
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }
      fail(
        503,
        `Signal runtime service read is unavailable: ${delegated.reason} ${SIGNAL_PLUGIN_SETUP_MESSAGE}`,
      );
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
      const normalizedSide =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const recipient = request.recipient.trim();
      const text = request.text.trim();
      if (!recipient) {
        fail(400, "recipient is required");
      }
      if (!text) {
        fail(400, "text is required");
      }

      const status = await this.getSignalConnectorStatus(normalizedSide);
      if (!status.connected) {
        fail(409, SIGNAL_PLUGIN_SETUP_MESSAGE);
      }
      if (!status.grantedCapabilities.includes("signal.send")) {
        fail(403, "Signal plugin is missing send permission.");
      }

      const delegated = await sendSignalMessageWithRuntimeService({
        runtime: this.runtime,
        grant: status.grant,
        recipient,
        text,
      });
      if (delegated.status === "handled") {
        return {
          provider: "signal",
          side: normalizedSide,
          recipient,
          ok: true,
          timestamp: delegated.value.timestamp,
        };
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_failed",
          delegated.reason,
          {
            provider: "signal",
            operation: "message.send",
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }
      fail(
        503,
        `Signal runtime service send is unavailable: ${delegated.reason} ${SIGNAL_PLUGIN_SETUP_MESSAGE}`,
      );
    }
  }

  return LifeOpsSignalServiceMixin;
}
