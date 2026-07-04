/**
 * Sleep history / regularity / personal-baseline reads, delegated to
 * `@elizaos/plugin-health`'s sleep service methods (health/circadian logic
 * belongs to plugin-health; LifeOps only projects it for the owner). Base-only
 * domain — no cross-domain dependencies.
 */
import { createHealthSleepServiceMethods } from "@elizaos/plugin-health";
import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
} from "@elizaos/shared";
import { resolveDefaultTimeZone } from "../defaults.js";
import type { LifeOpsContext } from "../lifeops-context.js";
export class SleepDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  /**
   * Returns the persisted historical sleep episode log for the requested
   * window. By default overnight episodes only; pass `includeNaps: true` to
   * include short nap episodes as well.
   */
  getSleepHistory(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepHistoryResponse> {
    return this.methods().getSleepHistory(opts);
  }

  /**
   * Returns the Sleep Regularity Index plus circular standard deviations over
   * the requested window. Defaults to overnight episodes only.
   */
  getSleepRegularity(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepRegularityResponse> {
    return this.methods().getSleepRegularity(opts);
  }

  /**
   * Returns the personal baseline (median bedtime, wake, duration) over the
   * requested window. Returns null medians when the underlying baseline has
   * fewer than the required number of episodes.
   */
  getPersonalBaseline(opts?: {
    windowDays?: number;
  }): Promise<LifeOpsPersonalBaselineResponse> {
    return this.methods().getPersonalBaseline(opts);
  }

  private methods() {
    return createHealthSleepServiceMethods({
      repository: this.ctx.repository,
      agentId: this.ctx.agentId(),
      resolveTimeZone: resolveDefaultTimeZone,
    });
  }
}
