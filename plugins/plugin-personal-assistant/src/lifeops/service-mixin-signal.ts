import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalInboundMessage,
} from "@elizaos/shared";
import { SignalDomain } from "./domains/signal-service.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withSignal<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsSignalServiceMixin extends Base {
    // `this` satisfies LifeOpsContext. Public to avoid TS4094 on the
    // re-exported mixin class.
    readonly signalDomain = new SignalDomain(this);

    lifeOpsSignalServiceConnected(): boolean {
      return this.signalDomain.lifeOpsSignalServiceConnected();
    }

    lifeOpsSignalServiceRegistered(): boolean {
      return this.signalDomain.lifeOpsSignalServiceRegistered();
    }

    getSignalConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsSignalConnectorStatus> {
      return this.signalDomain.getSignalConnectorStatus(side);
    }

    readSignalInbound(
      limit = 25,
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsSignalInboundMessage[]> {
      return this.signalDomain.readSignalInbound(limit, side);
    }

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
    }> {
      return this.signalDomain.sendSignalMessage(request);
    }
  }

  return LifeOpsSignalServiceMixin;
}

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
