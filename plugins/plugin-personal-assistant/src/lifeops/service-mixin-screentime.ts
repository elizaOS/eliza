/**
 * Screen-time service mixin: declares the LifeOps screen-time service surface
 * and the mixin that composes the screentime domain's summary/breakdown methods
 * onto the LifeOpsService base.
 */
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
