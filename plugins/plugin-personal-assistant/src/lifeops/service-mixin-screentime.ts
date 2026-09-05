/**
 * Screen-time service mixin: declares the LifeOps screen-time service surface
 * and the mixin that composes the screentime domain's summary/breakdown methods
 * onto the LifeOpsService base.
 */
import type {
  ScreenTimeAggregateRow,
  ScreenTimeAggregationService,
} from "@elizaos/plugin-health";
import type {
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeSession,
  LifeOpsScreenTimeSource,
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

export interface LifeOpsScreenTimeServicePublic
  extends ScreenTimeAggregationService {
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
  getSocialHabitSummary(opts: {
    since: string;
    until: string;
    topN?: number;
  }): Promise<SocialHabitSummary>;
  aggregateDailyForDate(date: string): Promise<{ updated: number }>;
}
