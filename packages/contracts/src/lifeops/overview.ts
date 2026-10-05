/** LifeOps overview contracts. Persisted and wire shapes are preserved. */

import type { LifeOpsGoalDefinition } from "./goals.js";
import type { LifeOpsScheduleInsight } from "./health.js";
import type { LifeOpsActiveReminderView } from "./reminders.js";
import type { LifeOpsOccurrenceView } from "./scheduling.js";

export interface LifeOpsOverviewSummary {
  activeOccurrenceCount: number;
  overdueOccurrenceCount: number;
  snoozedOccurrenceCount: number;
  activeReminderCount: number;
  activeGoalCount: number;
}

/** A Todo target is a stored unscheduled definition or an existing scheduled occurrence. */
export interface LifeOpsTodoView {
  id: string;
  targetKind: "definition" | "occurrence";
  title: string;
  status: "pending" | "in_progress" | "completed";
  dueDate: string | null;
  progress: LifeOpsOccurrenceView["progress"];
}

export interface LifeOpsOverviewSection {
  occurrences: LifeOpsOccurrenceView[];
  goals: LifeOpsGoalDefinition[];
  reminders: LifeOpsActiveReminderView[];
  summary: LifeOpsOverviewSummary;
}

export interface LifeOpsOverview {
  occurrences: LifeOpsOccurrenceView[];
  goals: LifeOpsGoalDefinition[];
  reminders: LifeOpsActiveReminderView[];
  summary: LifeOpsOverviewSummary;
  owner: LifeOpsOverviewSection;
  agentOps: LifeOpsOverviewSection;
  schedule: LifeOpsScheduleInsight | null;
}
