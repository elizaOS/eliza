// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
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
import { createLifeOpsConnectorGrant } from "./repository.js";
import {
  readSignalRecentWithRuntimeService,
  sendSignalMessageWithRuntimeService,
} from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import { normalizeOptionalConnectorSide } from "./service-normalize-connector.js";
import {
  deleteSignalLinkedDevice,
  findSignalLinkedDeviceInfoForSide,
  getSignalPairingStatus as getSignalPairingStatusFlow,
  getSignalPairingStatusForSide,
  readSignalLinkedDeviceInfo,
  startSignalPairing as startSignalPairingFlow,
  stopSignalPairing as stopSignalPairingFlow,
} from "./signal-auth.js";
import {
  readSignalInboundMessages,
  readSignalLocalClientConfigFromEnv,
  sendSignalLocalMessage,
} from "./signal-local-client.js";
import {
  removeSignalConnectorConfig,
  upsertSignalConnectorConfig,
} from "./signal-runtime-config.js";

type ConnectorSetupServiceLike = {
  getConfig(): Record<string, unknown>;
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
  registerEscalationChannel(channelName: string): boolean;
  setOwnerContact(update: {
    source: string;
    channelId?: string;
    entityId?: string;
    roomId?: string;
  }): boolean;
};

type RuntimeWithPluginLifecycle = {
  getPluginOwnership?: (pluginName: string) => { plugin: Plugin } | null;
  registerPlugin?: (plugin: Plugin) => Promise<void>;
  reloadPlugin?: (plugin: Plugin) => Promise<void>;
};

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

const FULL_SIGNAL_CAPABILITIES: LifeOpsSignalCapability[] = [
  ...LIFEOPS_SIGNAL_CAPABILITIES,
];

function normalizeSignalCapabilities(
  capabilities: readonly string[] | null | undefined,
): LifeOpsSignalCapability[] {
  return (capabilities ?? []).filter(
    (candidate): candidate is LifeOpsSignalCapability =>
      candidate === "signal.read" || candidate === "signal.send",
  );
}

function getConnectorSetupService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): ConnectorSetupServiceLike | null {
  return runtime.getService(
    "connector-setup",
  ) as ConnectorSetupServiceLike | null;
}

function getSignalService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): SignalServiceLike | null {
  const service = runtime.getService("signal") as SignalServiceLike | null;
  return service && typeof service === "object" ? service : null;
}

function signalServiceConnected(service: SignalServiceLike | null): boolean {
  return Boolean(service?.isServiceConnected?.());
}

function signalServiceCanRead(service: SignalServiceLike | null): boolean {
  return (
    signalServiceConnected(service) &&
    typeof service?.getRecentMessages === "function"
  );
}

function signalServiceCanSend(service: SignalServiceLike | null): boolean {
  return (
    signalServiceConnected(service) &&
    typeof service?.sendMessage === "function"
  );
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
  if (args.connected && granted.has("signal.read") && !args.inboundReady) {
    degradations.push({
      axis: "transport-offline",
      code: "signal_inbound_unavailable",
      message:
        "Signal is linked, but no runtime or signal-cli receive path is available for inbound reads.",
      retryable: true,
    });
  }
  if (args.connected && granted.has("signal.send") && !args.sendReady) {
    degradations.push({
      axis: "delivery-degraded",
      code: "signal_send_service_unavailable",
      message:
        "Signal is linked, but no runtime or signal-cli send path is available.",
      retryable: true,
    });
  }
  return degradations;
}

function signalAgentPluginDegradations(args: {
  connected: boolean;
  inboundReady: boolean;
  sendReady: boolean;
}): LifeOpsConnectorDegradation[] {
  if (!args.connected) {
    return [
      {
        axis: "transport-offline",
        code: "signal_plugin_unavailable",
        message:
          "Agent-side Signal is served by @elizaos/plugin-signal. Configure and enable the Signal plugin; LifeOps will not create a separate agent Signal device.",
        retryable: true,
      },
    ];
  }
  const degradations: LifeOpsConnectorDegradation[] = [];
  if (!args.inboundReady) {
    degradations.push({
      axis: "transport-offline",
      code: "signal_plugin_inbound_unavailable",
      message:
        "Agent-side Signal is connected, but the plugin does not expose an inbound read path.",
      retryable: true,
    });
  }
  if (!args.sendReady) {
    degradations.push({
      axis: "delivery-degraded",
      code: "signal_plugin_send_unavailable",
      message:
        "Agent-side Signal is connected, but the plugin does not expose a send path.",
      retryable: true,
    });
  }
  return degradations;
}

function setSignalRuntimeEnv(
  authDir: string | null,
  phoneNumber: string | null,
): void {
  if (authDir && authDir.trim().length > 0) {
    process.env.SIGNAL_AUTH_DIR = authDir.trim();
  } else {
    delete process.env.SIGNAL_AUTH_DIR;
  }

  if (phoneNumber && phoneNumber.trim().length > 0) {
    process.env.SIGNAL_ACCOUNT_NUMBER = phoneNumber.trim();
  } else {
    delete process.env.SIGNAL_ACCOUNT_NUMBER;
  }
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
      typeof record.id === "string"
        ? record.id
        : `signal-runtime-${createdAt}`,
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

async function ensureSignalPluginLoaded(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): Promise<boolean> {
  const runtimeWithLifecycle = runtime as typeof runtime &
    RuntimeWithPluginLifecycle;
  if (
    typeof runtimeWithLifecycle.registerPlugin !== "function" &&
    typeof runtimeWithLifecycle.reloadPlugin !== "function"
  ) {
    return false;
  }

  const mod = await import("@elizaos/plugin-signal");
  const plugin = (mod.default ?? (mod as { plugin?: Plugin }).plugin) as
    | Plugin
    | undefined;
  if (!plugin) {
    return false;
  }

  const existingOwnership =
    typeof runtimeWithLifecycle.getPluginOwnership === "function"
      ? runtimeWithLifecycle.getPluginOwnership("signal")
      : null;
  if (
    existingOwnership &&
    typeof runtimeWithLifecycle.reloadPlugin === "function"
  ) {
    await runtimeWithLifecycle.reloadPlugin(plugin);
    return true;
  }

  if (typeof runtimeWithLifecycle.registerPlugin === "function") {
    await runtimeWithLifecycle.registerPlugin(plugin);
    return true;
  }

  return false;
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
      return Boolean(this.runtime.getService("signal"));
    }

    async lifeOpsEnsureSignalRuntimeReady(
      authDir: string,
      phoneNumber: string,
    ): Promise<void> {
      const setupService = getConnectorSetupService(this.runtime);
      let configChanged = false;

      if (setupService) {
        const config = setupService.getConfig();
        configChanged = upsertSignalConnectorConfig(config, {
          authDir,
          account: phoneNumber,
        });
        if (configChanged) {
          setupService.updateConfig((nextConfig) => {
            upsertSignalConnectorConfig(nextConfig, {
              authDir,
              account: phoneNumber,
            });
          });
        }
        setupService.setOwnerContact({
          source: "signal",
          channelId: phoneNumber,
        });
        setupService.registerEscalationChannel("signal");
      }

      setSignalRuntimeEnv(authDir, phoneNumber);
      this.runtime.setSetting("SIGNAL_AUTH_DIR", authDir, false);
      this.runtime.setSetting("SIGNAL_ACCOUNT_NUMBER", phoneNumber, false);
      this.runtime.setSetting("SIGNAL_RECEIVE_MODE", "manual", false);
      this.runtime.setSetting("SIGNAL_AUTO_REPLY", "false", false);

      if (!configChanged && this.lifeOpsSignalServiceRegistered()) {
        return;
      }

      try {
        await ensureSignalPluginLoaded(this.runtime);
      } catch (error) {
        logger.warn(
          `[lifeops-signal] failed to reload Signal plugin after pairing: ${String(error)}`,
        );
      }
    }

    async lifeOpsClearSignalRuntimeConfig(
      authDir: string | null,
      phoneNumber: string | null,
    ): Promise<void> {
      const setupService = getConnectorSetupService(this.runtime);
      let configChanged = false;

      if (setupService) {
        const config = setupService.getConfig();
        configChanged = removeSignalConnectorConfig(config, {
          authDir,
          account: phoneNumber,
        });
        if (configChanged) {
          setupService.updateConfig((nextConfig) => {
            removeSignalConnectorConfig(nextConfig, {
              authDir,
              account: phoneNumber,
            });
          });
        }
      }

      if (configChanged || authDir || phoneNumber) {
        setSignalRuntimeEnv(null, null);
        this.runtime.setSetting("SIGNAL_AUTH_DIR", null, false);
        this.runtime.setSetting("SIGNAL_ACCOUNT_NUMBER", null, false);
      }

      if (!configChanged && !this.lifeOpsSignalServiceConnected()) {
        return;
      }

      try {
        await ensureSignalPluginLoaded(this.runtime);
      } catch (error) {
        logger.warn(
          `[lifeops-signal] failed to reload Signal plugin after disconnect: ${String(error)}`,
        );
      }
    }

    async getSignalConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsSignalConnectorStatus> {
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      if (resolvedSide === "agent") {
        const signalService = getSignalService(this.runtime);
        const inboundReady = signalServiceCanRead(signalService);
        const sendReady = signalServiceCanSend(signalService);
        const connected =
          signalServiceConnected(signalService) || inboundReady || sendReady;
        const capabilities = signalReadyCapabilities({
          granted: FULL_SIGNAL_CAPABILITIES,
          inboundReady,
          sendReady,
        });
        const phoneNumber = signalService?.getAccountNumber?.() ?? null;
        const degradations = signalAgentPluginDegradations({
          connected,
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

      let grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "signal",
        "local",
        resolvedSide,
      );
      const pairing = getSignalPairingStatusForSide(
        this.agentId(),
        resolvedSide,
      );

      let connected = false;
      let reason: LifeOpsSignalConnectorStatus["reason"] = "disconnected";
      let identity: LifeOpsSignalConnectorStatus["identity"] = null;

      if (!grant) {
        const candidate = findSignalLinkedDeviceInfoForSide(
          this.agentId(),
          resolvedSide,
        );
        if (candidate) {
          grant = createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "signal",
            identity: {
              phoneNumber: candidate.info.phoneNumber,
              uuid: candidate.info.uuid,
              deviceName: candidate.info.deviceName,
            },
            grantedScopes: [],
            capabilities: FULL_SIGNAL_CAPABILITIES,
            tokenRef: candidate.tokenRef,
            mode: "local",
            side: resolvedSide,
            metadata: {
              adoptedFromAgentId:
                candidate.agentId === this.agentId() ? null : candidate.agentId,
              adoptedTokenRef:
                candidate.tokenRef === candidate.info.authDir
                  ? null
                  : candidate.info.authDir,
            },
            lastRefreshAt: new Date().toISOString(),
          });
          await this.repository.upsertConnectorGrant(grant);
        }
      }

      let inboundReady = false;
      let sendReady = false;
      if (grant?.tokenRef) {
        const deviceInfo = readSignalLinkedDeviceInfo(grant.tokenRef);
        if (deviceInfo) {
          await this.lifeOpsEnsureSignalRuntimeReady(
            deviceInfo.authDir,
            deviceInfo.phoneNumber,
          );
          const signalService = getSignalService(this.runtime);
          const localClientConfig = readSignalLocalClientConfigFromEnv();
          inboundReady =
            signalServiceCanRead(signalService) || localClientConfig !== null;
          sendReady =
            signalServiceCanSend(signalService) || localClientConfig !== null;
          connected = inboundReady || sendReady;
          reason = connected ? "connected" : "disconnected";
          identity = {
            phoneNumber: deviceInfo.phoneNumber,
            uuid: deviceInfo.uuid,
            deviceName: deviceInfo.deviceName,
          };
        } else if (pairing) {
          reason = "pairing";
        } else {
          reason = "session_revoked";
        }
      } else if (pairing) {
        reason = "pairing";
      }

      const grantedCapabilities = normalizeSignalCapabilities(
        grant?.capabilities,
      );
      const capabilities = signalReadyCapabilities({
        granted: grantedCapabilities,
        inboundReady,
        sendReady,
      });
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
        reason,
        identity,
        grantedCapabilities: capabilities,
        pairing,
        grant,
        ...(degradations.length > 0 ? { degradations } : {}),
      };
    }

    async startSignalPairing(
      side?: LifeOpsConnectorSide,
    ): Promise<StartLifeOpsSignalPairingResponse> {
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      if (resolvedSide === "agent") {
        fail(
          409,
          "Agent-side Signal is managed by @elizaos/plugin-signal. Configure the Signal plugin instead of pairing a LifeOps Signal device.",
        );
      }
      const session = startSignalPairingFlow(this.agentId(), resolvedSide);

      const grant = createLifeOpsConnectorGrant({
        agentId: this.agentId(),
        provider: "signal",
        identity: {},
        grantedScopes: [],
        capabilities: FULL_SIGNAL_CAPABILITIES,
        tokenRef: session.authDir,
        mode: "local",
        side: resolvedSide,
        metadata: {
          pairingSessionId: session.sessionId,
        },
        lastRefreshAt: new Date().toISOString(),
      });
      await this.repository.upsertConnectorGrant(grant);

      return {
        provider: "signal",
        side: resolvedSide,
        sessionId: session.sessionId,
      };
    }

    async getSignalPairingStatus(
      sessionId: string,
    ): Promise<LifeOpsSignalPairingStatus> {
      if (!sessionId) {
        fail(400, "sessionId is required");
      }
      return getSignalPairingStatusFlow(sessionId);
    }

    stopSignalPairing(side?: LifeOpsConnectorSide): LifeOpsSignalPairingStatus {
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const result = stopSignalPairingFlow(this.agentId(), resolvedSide);
      return {
        sessionId: result.sessionId ?? "",
        state: result.stopped ? "idle" : "failed",
        qrDataUrl: null,
        error: result.stopped ? null : "No active pairing session to stop",
      };
    }

    async disconnectSignal(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsSignalConnectorStatus> {
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      if (resolvedSide === "agent") {
        fail(
          409,
          "Agent-side Signal is owned by @elizaos/plugin-signal. Disable or reconfigure the Signal plugin instead of deleting a LifeOps grant.",
        );
      }
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "signal",
        "local",
        resolvedSide,
      );

      if (grant) {
        const deviceInfo = grant.tokenRef
          ? readSignalLinkedDeviceInfo(grant.tokenRef)
          : null;
        if (grant.tokenRef) {
          deleteSignalLinkedDevice(grant.tokenRef);
        }
        await this.repository.deleteConnectorGrant(
          this.agentId(),
          "signal",
          "local",
          resolvedSide,
        );
        await this.lifeOpsClearSignalRuntimeConfig(
          grant.tokenRef,
          deviceInfo?.phoneNumber ?? null,
        );
      }

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

    /**
     * Read recent inbound Signal messages.
     *
     * Primary path: the Signal service (`@elizaos/plugin-signal`) is connected
     * and exposes a `getRecentMessages()` call on its in-memory store.
     *
     * Fallback path: when the service is absent or disconnected but
     * `SIGNAL_HTTP_URL` and `SIGNAL_ACCOUNT_NUMBER` are set, reads directly
     * from the signal-cli REST API via {@link readSignalInboundMessages}.
     * This mirrors how `telegram-local-client.ts` reads Telegram sessions
     * without the plugin service being active.
     *
     * Throws when neither path is available so a missing read transport is not
     * mistaken for an empty Signal inbox.
     */
    async readSignalInbound(
      limit = 25,
    ): Promise<LifeOpsSignalInboundMessage[]> {
      const signalService = getSignalService(this.runtime);
      const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
      const delegated = await readSignalRecentWithRuntimeService({
        runtime: this.runtime,
        limit: clampedLimit,
      });
      if (delegated.status === "handled" && delegated.value.length > 0) {
        return delegated.value.map(signalRuntimeMessageToLifeOps);
      }
      if (delegated.status === "fallback" && delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
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

      const localClientConfig = readSignalLocalClientConfigFromEnv();
      let serviceReadAttempted = delegated.status === "handled";

      // Primary path: use the Signal service's in-memory message store when it
      // exists. In passive LifeOps mode the plugin is connected for send/status
      // only, so this will usually be empty and the direct pull below owns reads.
      if (!serviceReadAttempted && signalServiceCanRead(signalService)) {
        serviceReadAttempted = true;
        const raw = await signalService.getRecentMessages?.(clampedLimit);
        if (raw && raw.length > 0) {
          return raw.map(signalRuntimeMessageToLifeOps);
        }
      }

      // Passive pull path: read directly from the signal-cli REST API.
      if (localClientConfig) {
        return readSignalInboundMessages(localClientConfig, clampedLimit);
      }

      if (serviceReadAttempted) {
        return [];
      }

      fail(
        409,
        "Signal inbound is not configured. Link Signal or configure signal-cli receive before reading messages.",
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

      if (normalizedSide === "agent") {
        const delegated = await sendSignalMessageWithRuntimeService({
          runtime: this.runtime,
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
            "runtime_service_delegation_fallback",
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
        const signalService = getSignalService(this.runtime);
        if (!signalServiceCanSend(signalService)) {
          fail(503, "Agent-side Signal plugin send service is not available.");
        }
        const result = await signalService.sendMessage(recipient, text, {
          accountId: "default",
        });
        if (
          typeof result.timestamp !== "number" ||
          !Number.isFinite(result.timestamp)
        ) {
          fail(502, "Signal send did not return a timestamp.");
        }
        return {
          provider: "signal",
          side: normalizedSide,
          recipient,
          ok: true,
          timestamp: result.timestamp,
        };
      }

      const status = await this.getSignalConnectorStatus(normalizedSide);
      if (!status.connected) {
        fail(409, "Signal is not connected.");
      }
      if (!status.grantedCapabilities.includes("signal.send")) {
        fail(403, "Signal send capability is not granted.");
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
          "runtime_service_delegation_fallback",
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

      const signalService = getSignalService(this.runtime);
      const localClientConfig = readSignalLocalClientConfigFromEnv();
      if (!signalServiceCanSend(signalService) && !localClientConfig) {
        fail(503, "Signal send service is not available.");
      }

      const result = signalServiceCanSend(signalService)
        ? await signalService.sendMessage(recipient, text, {
            accountId: status.grant?.connectorAccountId ?? "default",
          })
        : await sendSignalLocalMessage(localClientConfig, { recipient, text });
      if (
        typeof result.timestamp !== "number" ||
        !Number.isFinite(result.timestamp)
      ) {
        fail(502, "Signal send did not return a timestamp.");
      }

      return {
        provider: "signal",
        side: normalizedSide,
        recipient,
        ok: true,
        timestamp: result.timestamp,
      };
    }
  }

  return LifeOpsSignalServiceMixin;
}
