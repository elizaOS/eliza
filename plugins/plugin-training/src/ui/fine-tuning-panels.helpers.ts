// Non-component constants, formatters, and the training-event parser used by the
// fine-tuning panels and the dashboard view. Kept out of fine-tuning-panels.tsx
// so that file exports only React components and stays Fast-Refresh-compatible.
import type { TrainingStreamEvent } from "@elizaos/ui/api";

export type TranslateFn = (
  key: string,
  options?: Record<string, unknown>,
) => string;

/* ── Constants ─────────────────────────────────────────────────────── */

export const TRAINING_EVENT_KINDS = new Set<TrainingStreamEvent["kind"]>([
  "job_started",
  "job_progress",
  "job_log",
  "job_completed",
  "job_failed",
  "job_cancelled",
  "dataset_built",
  "model_activated",
  "model_imported",
]);

export const FINE_TUNING_PAGE_CLASS = "space-y-6 pb-8";
export const FINE_TUNING_SECTION_CLASS =
  "rounded-2xl border border-border/60 bg-card/70 p-5 shadow-sm ring-1 ring-border/15";
export const FINE_TUNING_SECTION_HEADER_CLASS =
  "mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between";
export const FINE_TUNING_SECTION_KICKER_CLASS =
  "text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70";
export const FINE_TUNING_PANEL_CLASS =
  "rounded-2xl border border-border/45 bg-bg/20 shadow-sm";
export const FINE_TUNING_PANEL_HEADER_CLASS =
  "px-3 py-2 text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70";
export const FINE_TUNING_ACTION_CLASS =
  "min-h-11 rounded-xl px-3 text-xs shadow-sm hover:border-accent disabled:opacity-50";
export const FINE_TUNING_STATUS_CARD_CLASS =
  "rounded-xl border border-border/35 bg-bg/30 px-3 py-3 shadow-sm";

/* ── Formatting helpers ────────────────────────────────────────────── */

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export function formatProgress(value: number): string {
  const bounded = Math.max(0, Math.min(1, value));
  return `${Math.round(bounded * 100)}%`;
}

/* ── Event parsing ─────────────────────────────────────────────────── */

export function asTrainingEvent(envelope: {
  type?: string;
  payload?: unknown;
}): TrainingStreamEvent | null {
  if (envelope.type !== "training_event") return null;
  const payloadValue = envelope.payload;
  if (!payloadValue || typeof payloadValue !== "object") return null;
  const payload = payloadValue as Partial<TrainingStreamEvent>;
  if (typeof payload.kind !== "string") return null;
  if (!TRAINING_EVENT_KINDS.has(payload.kind as TrainingStreamEvent["kind"])) {
    return null;
  }
  if (typeof payload.ts !== "number") return null;
  if (typeof payload.message !== "string") return null;
  return {
    kind: payload.kind as TrainingStreamEvent["kind"],
    ts: payload.ts,
    message: payload.message,
    jobId: typeof payload.jobId === "string" ? payload.jobId : undefined,
    modelId: typeof payload.modelId === "string" ? payload.modelId : undefined,
    datasetId:
      typeof payload.datasetId === "string" ? payload.datasetId : undefined,
    progress:
      typeof payload.progress === "number" ? payload.progress : undefined,
    phase: typeof payload.phase === "string" ? payload.phase : undefined,
  };
}

/* ── Availability summary ──────────────────────────────────────────── */

export function summarizeAvailability(
  reason: string | undefined,
  t: TranslateFn,
): string {
  if (!reason) return t("finetuningview.Unavailable");
  if (reason === "runtime_not_started") {
    return t("finetuningview.RuntimeNotStarted");
  }
  if (reason === "trajectories_table_missing") {
    return t("finetuningview.NoTrajectoriesTableFound");
  }
  return reason;
}
