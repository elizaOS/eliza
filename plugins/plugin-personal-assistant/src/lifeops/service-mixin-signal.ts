/**
 * Signal service mixin: declares the LifeOps Signal service surface and the
 * mixin that composes the signal domain's read/send/status methods onto the
 * LifeOpsService base.
 */
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalInboundMessage,
} from "@elizaos/shared";

/** Public surface added by {@link withSignal}; listed on the LifeOpsService
 * declaration-merge (mixin composition exceeds TS inference depth). Type-only. */
export interface LifeOpsSignalService {
  getSignalConnectorStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsSignalConnectorStatus>;
  readSignalInbound(
    limit?: number,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsSignalInboundMessage[]>;
  sendSignalMessage(request: {
    side?: LifeOpsConnectorSide;
    recipient: string;
    text: string;
  }): Promise<{
    provider: "signal";
    side: LifeOpsConnectorSide;
    recipient: string;
    ok: true;
    timestamp: number;
  }>;
}
