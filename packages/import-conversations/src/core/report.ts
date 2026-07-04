/**
 * Plan/apply report — mirrors ocplatform's migration report discipline
 * (scope §2.1 / §4.3): every conversation ends in a classified outcome with a
 * reason, and the report surfaces "what was NOT imported and why".
 */

import type { ConversationChange } from "./manifest.ts";
import type { ConversationSource } from "./types.ts";

/** Terminal outcome for a single conversation in a run. */
export type ConversationOutcome =
  | "added"
  | "unchanged"
  | "updated"
  | "skipped"
  | "error";

/** Why a conversation was skipped or errored (free-form, human-readable). */
export const SKIP_REASON_NO_MESSAGES =
  "conversation has no renderable messages";
export const SKIP_REASON_DUPLICATE_CONTENT =
  "identical content already stored (dedup)";
export const SKIP_REASON_UNCHANGED = "unchanged since last import";

/** Per-conversation report line. */
export interface ReportItem {
  sourceConversationId: string;
  title?: string;
  outcome: ConversationOutcome;
  /** Populated for skipped/error/unchanged outcomes. */
  reason?: string;
  /** Number of documents (parts) stored for this conversation. */
  documentCount: number;
}

/** Aggregate counts across a run. */
export interface ReportSummary {
  total: number;
  added: number;
  unchanged: number;
  updated: number;
  skipped: number;
  errors: number;
  documentsStored: number;
}

/** A full plan-or-apply report. */
export interface ImportReport {
  source: ConversationSource;
  batchId: string;
  /** True for a dry-run plan, false for an applied run. */
  dryRun: boolean;
  summary: ReportSummary;
  items: ReportItem[];
}

/** Mutable accumulator used by the pipeline to build a report incrementally. */
export class ReportBuilder {
  private readonly items: ReportItem[] = [];

  constructor(
    private readonly source: ConversationSource,
    private readonly batchId: string,
    private readonly dryRun: boolean,
  ) {}

  /** Record a stored/changed conversation. */
  record(params: {
    sourceConversationId: string;
    title?: string;
    change: ConversationChange;
    documentCount: number;
  }): void {
    this.items.push({
      sourceConversationId: params.sourceConversationId,
      title: params.title,
      outcome: params.change,
      reason: params.change === "unchanged" ? SKIP_REASON_UNCHANGED : undefined,
      documentCount: params.documentCount,
    });
  }

  /** Record a conversation that was skipped, with a reason. */
  skip(params: {
    sourceConversationId: string;
    title?: string;
    reason: string;
  }): void {
    this.items.push({
      sourceConversationId: params.sourceConversationId,
      title: params.title,
      outcome: "skipped",
      reason: params.reason,
      documentCount: 0,
    });
  }

  /** Record a conversation that errored, with a reason. */
  error(params: {
    sourceConversationId: string;
    title?: string;
    reason: string;
  }): void {
    this.items.push({
      sourceConversationId: params.sourceConversationId,
      title: params.title,
      outcome: "error",
      reason: params.reason,
      documentCount: 0,
    });
  }

  /** Finalize into an immutable {@link ImportReport}. */
  build(): ImportReport {
    const summary: ReportSummary = {
      total: this.items.length,
      added: 0,
      unchanged: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      documentsStored: 0,
    };
    for (const item of this.items) {
      switch (item.outcome) {
        case "added":
          summary.added += 1;
          break;
        case "unchanged":
          summary.unchanged += 1;
          break;
        case "updated":
          summary.updated += 1;
          break;
        case "skipped":
          summary.skipped += 1;
          break;
        case "error":
          summary.errors += 1;
          break;
      }
      summary.documentsStored += item.documentCount;
    }
    return {
      source: this.source,
      batchId: this.batchId,
      dryRun: this.dryRun,
      summary,
      items: this.items.slice(),
    };
  }
}

/** Conversations that were not imported (skipped or errored), with reasons. */
export function notImported(report: ImportReport): ReportItem[] {
  return report.items.filter(
    (item) => item.outcome === "skipped" || item.outcome === "error",
  );
}

/** Render a compact human-readable one-line summary of a report. */
export function summarizeReport(report: ImportReport): string {
  const s = report.summary;
  const mode = report.dryRun ? "plan" : "apply";
  return (
    `[${report.source} ${mode} ${report.batchId}] ` +
    `total=${s.total} added=${s.added} unchanged=${s.unchanged} ` +
    `updated=${s.updated} skipped=${s.skipped} errors=${s.errors} ` +
    `docs=${s.documentsStored}`
  );
}
