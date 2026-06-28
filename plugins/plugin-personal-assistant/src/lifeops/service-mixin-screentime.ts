import type {
  ScreenTimeAggregateRow,
  ScreenTimeWeeklyAverageItem,
} from "@elizaos/plugin-health";
import type {
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSession,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeBreakdown as ScreenTimeBreakdown,
  LifeOpsSocialHabitSummary as SocialHabitSummary,
} from "@elizaos/shared";
import {
  ScreenTimeDomain,
  type ScreenTimeDomainDeps,
} from "./domains/screentime-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

type ScreenTimeEventInput = {
  source: "app" | "website";
  identifier: string;
  displayName: string;
  startAt: string;
  endAt?: string | null;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
};

type ScreenTimeWeeklyAverageResponse = {
  items: ScreenTimeWeeklyAverageItem[];
  totalSeconds: number;
  daysInWindow: number;
};

export interface LifeOpsScreenTimeServicePublic {
  recordScreenTimeEvent(
    event: ScreenTimeEventInput,
  ): Promise<LifeOpsScreenTimeSession>;
  finishActiveScreenTimeSession(
    id: string,
    endAt: string,
    durationSeconds: number,
  ): Promise<void>;
  collectScreenTimeRows(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
  }): Promise<ScreenTimeAggregateRow[]>;
  getScreenTimeDaily(opts: {
    date: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    limit?: number;
  }): Promise<LifeOpsScreenTimeDaily[]>;
  getScreenTimeSummary(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    topN?: number;
  }): Promise<LifeOpsScreenTimeSummary>;
  getScreenTimeBreakdown(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    topN?: number;
  }): Promise<ScreenTimeBreakdown>;
  getSocialHabitSummary(opts: {
    since: string;
    until: string;
    topN?: number;
  }): Promise<SocialHabitSummary>;
  getScreenTimeHistory(opts: {
    range: LifeOpsScreenTimeRangeKey;
    topN?: number;
    socialTopN?: number;
  }): Promise<LifeOpsScreenTimeHistoryResponse>;
  getScreenTimeWeeklyAverageByApp(opts: {
    since: string;
    until: string;
    daysInWindow: number;
    identifier?: string;
    topN?: number;
  }): Promise<ScreenTimeWeeklyAverageResponse>;
  aggregateDailyForDate(date: string): Promise<{ updated: number }>;
}

/** @internal */
export function withScreenTime<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsScreenTimeServicePublic> {
  class LifeOpsScreenTimeServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly screenTimeDomain = new ScreenTimeDomain(this, {
      getBrowserSettings: (...args) =>
        (
          this as unknown as {
            getBrowserSettings(
              ...a: Parameters<ScreenTimeDomainDeps["getBrowserSettings"]>
            ): ReturnType<ScreenTimeDomainDeps["getBrowserSettings"]>;
          }
        ).getBrowserSettings(...args),
      listBrowserCompanions: (...args) =>
        (
          this as unknown as {
            listBrowserCompanions(
              ...a: Parameters<ScreenTimeDomainDeps["listBrowserCompanions"]>
            ): ReturnType<ScreenTimeDomainDeps["listBrowserCompanions"]>;
          }
        ).listBrowserCompanions(...args),
    });

    recordScreenTimeEvent(
      event: ScreenTimeEventInput,
    ): Promise<LifeOpsScreenTimeSession> {
      return this.screenTimeDomain.recordScreenTimeEvent(event);
    }

    finishActiveScreenTimeSession(
      id: string,
      endAt: string,
      durationSeconds: number,
    ): Promise<void> {
      return this.screenTimeDomain.finishActiveScreenTimeSession(
        id,
        endAt,
        durationSeconds,
      );
    }

    collectScreenTimeRows(opts: {
      since: string;
      until: string;
      source?: LifeOpsScreenTimeSource;
      identifier?: string;
    }): Promise<ScreenTimeAggregateRow[]> {
      return this.screenTimeDomain.collectScreenTimeRows(opts);
    }

    getScreenTimeDaily(opts: {
      date: string;
      source?: LifeOpsScreenTimeSource;
      identifier?: string;
      limit?: number;
    }): Promise<LifeOpsScreenTimeDaily[]> {
      return this.screenTimeDomain.getScreenTimeDaily(opts);
    }

    getScreenTimeSummary(opts: {
      since: string;
      until: string;
      source?: LifeOpsScreenTimeSource;
      identifier?: string;
      topN?: number;
    }): Promise<LifeOpsScreenTimeSummary> {
      return this.screenTimeDomain.getScreenTimeSummary(opts);
    }

    getScreenTimeBreakdown(opts: {
      since: string;
      until: string;
      source?: LifeOpsScreenTimeSource;
      identifier?: string;
      topN?: number;
    }): Promise<ScreenTimeBreakdown> {
      return this.screenTimeDomain.getScreenTimeBreakdown(opts);
    }

    getSocialHabitSummary(opts: {
      since: string;
      until: string;
      topN?: number;
    }): Promise<SocialHabitSummary> {
      return this.screenTimeDomain.getSocialHabitSummary(opts);
    }

    getScreenTimeHistory(opts: {
      range: LifeOpsScreenTimeRangeKey;
      topN?: number;
      socialTopN?: number;
    }): Promise<LifeOpsScreenTimeHistoryResponse> {
      return this.screenTimeDomain.getScreenTimeHistory(opts);
    }

    getScreenTimeWeeklyAverageByApp(opts: {
      since: string;
      until: string;
      daysInWindow: number;
      identifier?: string;
      topN?: number;
    }): Promise<ScreenTimeWeeklyAverageResponse> {
      return this.screenTimeDomain.getScreenTimeWeeklyAverageByApp(opts);
    }

    aggregateDailyForDate(date: string): Promise<{ updated: number }> {
      return this.screenTimeDomain.aggregateDailyForDate(date);
    }
  }
  return LifeOpsScreenTimeServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsScreenTimeServicePublic
  >;
}
