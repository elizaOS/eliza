/**
 * `LifeOpsBriefing` domain type.
 *
 * PRD: `prd-lifeops-executive-assistant.md` §Daily Operations, and
 * `plan-lifeops-executive-assistant-scenario-matrix.md` + the 2026-04-23
 * "proactive life agent" plan (Phase 2). Wave-2 scenarios assert against this
 * shape; Wave-1 (W2-5) only ships the scaffold + composer.
 *
 * A LifeOpsBriefing is a structured snapshot the agent can compose into prose
 * for morning / evening / weekly digests. Each section is optional so the
 * `include` arg on the BRIEF action can suppress domains the owner doesn't
 * want surfaced.
 */

export type LifeOpsBriefingPeriod = "today" | "tomorrow" | "this_week";

export type LifeOpsBriefingKind = "morning" | "evening" | "weekly";

export interface LifeOpsBriefingCalendarItem {
  readonly id: string;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly location?: string;
}

export interface LifeOpsBriefingInboxItem {
  readonly id: string;
  readonly channel: string;
  readonly senderName: string;
  readonly snippet: string;
  readonly urgency: "low" | "medium" | "high" | "unknown";
  readonly classification: string;
}

export interface LifeOpsBriefingLifeItem {
  readonly id: string;
  readonly kind: "todo" | "reminder" | "habit" | "goal";
  readonly title: string;
  readonly dueAt: string | null;
}

export interface LifeOpsBriefingMoneyItem {
  readonly id: string;
  readonly merchant: string;
  readonly amountUsd: number;
  readonly cadence: "daily" | "weekly" | "monthly" | "yearly" | "irregular";
  readonly nextChargeAt: string | null;
}

export interface LifeOpsBriefingSections {
  readonly calendar?: readonly LifeOpsBriefingCalendarItem[];
  readonly inbox?: readonly LifeOpsBriefingInboxItem[];
  readonly life?: readonly LifeOpsBriefingLifeItem[];
  readonly money?: readonly LifeOpsBriefingMoneyItem[];
}

export interface LifeOpsBriefing {
  readonly id: string;
  readonly kind: LifeOpsBriefingKind;
  readonly period: LifeOpsBriefingPeriod;
  readonly generatedAt: string;
  readonly sections: LifeOpsBriefingSections;
  /** Free-form narrative composed by the LLM compose pass. */
  readonly narrative?: string;
}
