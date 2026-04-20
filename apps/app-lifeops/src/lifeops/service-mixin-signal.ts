// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { Plugin } from "@elizaos/core";
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalInboundMessage,
  LifeOpsSignalPairingStatus,
  StartLifeOpsSignalPairingResponse,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_SIGNAL_CAPABILITIES,
  capabilitiesForSide,
} from "@elizaos/shared/contracts/lifeops";
import { logger } from "@elizaos/core";
import { createLifeOpsConnectorGrant } from "./repository.js";
import {
  fail,
} from "./service-normalize.js";
import {
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import {
  startSignalPairing as startSignalPairingFlow,
  getSignalPairingStatus as getSignalPairingStatusFlow,
  getSignalPairingStatusForSide,
  stopSignalPairing as stopSignalPairingFlow,
  readSignalLinkedDeviceInfo,
  deleteSignalLinkedDevice,
} from "./signal-auth.js";
import {
  removeSignalConnectorConfig,
  upsertSignalConnectorConfig,
} from "./signal-runtime-config.js";
import {
  readSignalInboundMessages,
  readSignalLocalClientConfigFromEnv,
} from "./signal-local-client.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

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

function getConnectorSetupService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): ConnectorSetupServiceLike | null {
  return runtime.getService("connector-setup") as ConnectorSetupServiceLike | null;
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
  const runtimeWithLifecycle = runtime as typeof runtime & RuntimeWithPluginLifecycle;
  if (
    typeof runtimeWithLifecycle.registerPlugin !== "function" &&
    typeof runtimeWithLifecycle.reloadPlugin !== "function"
  ) {
    return false;
  }

  const mod = await import("@elizaos/plugin-signal");
  const plugin = (mod.default ??
    (mod as { plugin?: Plugin }).plugin) as Plugin | undefined;
  if (!plugin) {
    return false;
  }

  const existingOwnership =
    typeof runtimeWithLifecycle.getPluginOwnership === "function"
      ? runtimeWithLifecycle.getPluginOwnership("signal")
      : null;
  if (existingOwnership && typeof runtimeWithLifecycle.reloadPlugin === "function") {
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
export function withSignal<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsSignalServiceMixin extends Base {
    lifeOpsSignalServiceConnected(): boolean {
      const signalService = this.runtime.getService("signal") as
        | {
            getAccountNumber?: () => string | null;
            isServiceConnected?: () => boolean;
          }
        | null;
      return Boolean(
        signalService?.isServiceConnected?.(),
      );
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
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "signal",
        "local",
        resolvedSide,
      );
      const pairing = getSignalPairingStatusForSide(this.agentId(), resolvedSide);

      let connected = false;
      let reason: LifeOpsSignalConnectorStatus["reason"] = "disconnected";
      let identity: LifeOpsSignalConnectorStatus["identity"] = null;

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
        capabilities: capabilitiesForSide(LIFEOPS_SIGNAL_CAPABILITIES, resolvedSide),
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

    stopSignalPairing(
      side?: LifeOpsConnectorSide,
    ): LifeOpsSignalPairingStatus {
      const resolvedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      stopSignalPairingFlow(this.agentId(), resolvedSide);
      return {
        sessionId: "",
        state: "idle",
        qrDataUrl: null,
        error: null,
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
        inbound: true,
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
        getRecentMessages?: (
          limit?: number,
        ) => Promise<
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
      const signalService = this.runtime.getService("signal") as SignalServiceLike | null;
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
            speakerName: entry.speakerName,
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
  }

  return LifeOpsSignalServiceMixin;
}
