// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalPairingStatus,
  StartLifeOpsSignalPairingResponse,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_SIGNAL_CAPABILITIES,
} from "@elizaos/shared/contracts/lifeops";
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
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withSignal<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsSignalServiceMixin extends Base {
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
        capabilities: [...LIFEOPS_SIGNAL_CAPABILITIES],
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
        if (grant.tokenRef) {
          deleteSignalLinkedDevice(grant.tokenRef);
        }
        await this.repository.deleteConnectorGrant(
          this.agentId(),
          "signal",
          "local",
          resolvedSide,
        );
      }

      return {
        provider: "signal",
        side: resolvedSide,
        connected: false,
        reason: "disconnected",
        identity: null,
        grantedCapabilities: [],
        pairing: null,
        grant: null,
      };
    }
  }

  return LifeOpsSignalServiceMixin;
}
