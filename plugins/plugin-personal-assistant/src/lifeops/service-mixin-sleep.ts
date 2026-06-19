import { createHealthSleepServiceMethods } from "@elizaos/plugin-health";
import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
} from "@elizaos/shared";
import { resolveDefaultTimeZone } from "./defaults.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withSleep<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsSleepServiceMixin extends Base {
    /**
     * Returns the persisted historical sleep episode log for the requested
     * window. By default overnight episodes only; pass `includeNaps: true`
     * to include short nap episodes as well.
     */
    async getSleepHistory(opts?: {
      windowDays?: number;
      includeNaps?: boolean;
    }): Promise<LifeOpsSleepHistoryResponse> {
      return this.createHealthSleepServiceMethods().getSleepHistory(opts);
    }

    /**
     * Returns the Sleep Regularity Index plus circular standard deviations
     * over the requested window. Defaults to overnight episodes only.
     */
    async getSleepRegularity(opts?: {
      windowDays?: number;
      includeNaps?: boolean;
    }): Promise<LifeOpsSleepRegularityResponse> {
      return this.createHealthSleepServiceMethods().getSleepRegularity(opts);
    }

    /**
     * Returns the personal baseline (median bedtime, wake, duration) over the
     * requested window. Returns null medians when the underlying baseline has
     * fewer than the required number of episodes.
     */
    async getPersonalBaseline(opts?: {
      windowDays?: number;
    }): Promise<LifeOpsPersonalBaselineResponse> {
      return this.createHealthSleepServiceMethods().getPersonalBaseline(opts);
    }

    // Cannot be `private` — TS4094 fires when the mixin's anonymous class
    // is re-exported through the composed LifeOpsService.
    createHealthSleepServiceMethods() {
      return createHealthSleepServiceMethods({
        repository: this.repository,
        agentId: this.agentId(),
        resolveTimeZone: resolveDefaultTimeZone,
      });
    }
  }
  return LifeOpsSleepServiceMixin;
}
