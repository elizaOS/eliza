// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  LIFEOPS_SIGNAL_CAPABILITIES,
  type LifeOpsConnectorSide,
  type LifeOpsSignalConnectorStatus,
  type LifeOpsSignalInboundMessage,
  type LifeOpsSignalPairingStatus,
  type StartLifeOpsSignalPairingResponse,
} from "@elizaos/shared";
import { createLifeOpsConnectorGrant } from "./repository.js";
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

const FULL_SIGNAL_CAPABILITIES = [...LIFEOPS_SIGNAL_CAPABILITIES];

function withFullSignalCapabilities(
  capabilities: readonly string[] | null | undefined,
): Array<"signal.read" | "signal.send"> {
  const normalized = new Set(
    (capabilities ?? []).filter(
      (candidate): candidate is "signal.read" | "signal.send" =>
        candidate === "signal.read" || candidate === "signal.send",
    ),
  );
  for (const capability of FULL_SIGNAL_CAPABILITIES) {
    normalized.add(capability);
  }
  return [...normalized];
}

function getConnectorSetupService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): ConnectorSetupServiceLike | null {
  return runtime.getService(
    "connector-setup",
  ) as ConnectorSetupServiceLike | null;
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
      const signalService = this.runtime.getService("signal") as {
        getAccountNumber?: () => string | null;
        isServiceConnected?: () => boolean;
      } | null;
      return Boolean(signalService?.isServiceConnected?.());
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

      if (grant) {
        const fullCapabilities = withFullSignalCapabilities(grant.capabilities);
        if (fullCapabilities.length !== (grant.capabilities ?? []).length) {
          grant = {
            ...grant,
            capabilities: fullCapabilities,
            lastRefreshAt: new Date().toISOString(),
          };
          await this.repository.upsertConnectorGrant(grant);
        }
      }

      if (grant?.tokenRef) {
        const deviceInfo = readSignalLinkedDeviceInfo(grant.tokenRef);
        if (deviceInfo) {
          await this.lifeOpsEnsureSignalRuntimeReady(
            deviceInfo.authDir,
            deviceInfo.phoneNumber,
          );
          connected = true;
          reason = "connected";
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

      const capabilities = (grant?.capabilities ?? []).filter(
        (candidate): candidate is "signal.read" | "signal.send" =>
          candidate === "signal.read" || candidate === "signal.send",
      );

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
      };
    }

    async startSignalPairing(
      side?: LifeOpsConnectorSide,
    ): Promise<StartLifeOpsSignalPairingResponse> {
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
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
     * Returns an empty array when neither path is available.
     * Does not throw — callers should check connector status separately.
     */
    async readSignalInbound(
      limit = 25,
    ): Promise<LifeOpsSignalInboundMessage[]> {
      type SignalServiceLike = {
        isServiceConnected?: () => boolean;
        getRecentMessages?: (limit?: number) => Promise<
          Array<{
            id: string;
            roomId: string;
            channelId: string;
            roomName: string;
            speakerName: string;
            text: string;
            createdAt: number;
            isFromAgent: boolean;
            isGroup: boolean;
          }>
        >;
      };
      const signalService = this.runtime.getService(
        "signal",
      ) as SignalServiceLike | null;
      const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), 100);

      // Primary path: use the Signal service's in-memory message store.
      if (signalService?.isServiceConnected?.()) {
        const raw = await signalService.getRecentMessages?.(clampedLimit);
        if (!raw || raw.length === 0) {
          return [];
        }
        return raw.map(
          (entry): LifeOpsSignalInboundMessage => ({
            id: entry.id,
            roomId: entry.roomId,
            channelId: entry.channelId,
            threadId: entry.channelId || entry.roomId,
            roomName: entry.roomName,
            speakerName: entry.speakerName,
            senderNumber: entry.isGroup ? null : entry.channelId || null,
            senderUuid: null,
            sourceDevice: null,
            groupId: entry.isGroup ? entry.channelId || null : null,
            groupType: null,
            text: entry.text,
            createdAt: entry.createdAt,
            isInbound: !entry.isFromAgent,
            isGroup: entry.isGroup,
          }),
        );
      }

      // Fallback path: read directly from the signal-cli REST API.
      const localClientConfig = readSignalLocalClientConfigFromEnv();
      if (localClientConfig) {
        return readSignalInboundMessages(localClientConfig, clampedLimit);
      }

      return [];
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
        fail(409, "Signal is not connected.");
      }
      if (!status.grantedCapabilities.includes("signal.send")) {
        fail(403, "Signal send capability is not granted.");
      }

      const signalService = this.runtime.getService("signal") as
        | {
            sendMessage?: (
              recipient: string,
              text: string,
            ) => Promise<{ timestamp?: number }>;
          }
        | null;
      if (typeof signalService?.sendMessage !== "function") {
        fail(503, "Signal send service is not available.");
      }

      const result = await signalService.sendMessage(recipient, text);
      const timestamp =
        typeof result.timestamp === "number" && Number.isFinite(result.timestamp)
          ? result.timestamp
          : Date.now();

      return {
        provider: "signal",
        side: normalizedSide,
        recipient,
        ok: true,
        timestamp,
      };
    }
  }

  return LifeOpsSignalServiceMixin;
}
