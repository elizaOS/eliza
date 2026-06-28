import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
} from "@elizaos/shared";
import { SleepDomain } from "./domains/sleep-service.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withSleep<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsSleepServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly sleepDomain = new SleepDomain(this);

    getSleepHistory(opts?: {
      windowDays?: number;
      includeNaps?: boolean;
    }): Promise<LifeOpsSleepHistoryResponse> {
      return this.sleepDomain.getSleepHistory(opts);
    }

    getSleepRegularity(opts?: {
      windowDays?: number;
      includeNaps?: boolean;
    }): Promise<LifeOpsSleepRegularityResponse> {
      return this.sleepDomain.getSleepRegularity(opts);
    }

    getPersonalBaseline(opts?: {
      windowDays?: number;
    }): Promise<LifeOpsPersonalBaselineResponse> {
      return this.sleepDomain.getPersonalBaseline(opts);
    }
  }
  return LifeOpsSleepServiceMixin;
}
