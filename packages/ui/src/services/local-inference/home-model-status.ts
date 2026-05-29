import type {
  LocalInferenceReadiness,
  LocalInferenceSlotReadiness,
} from "./types";

export type HomeModelStatusKind =
  | "not-required"
  | "ready"
  | "downloading"
  | "loading"
  | "missing"
  | "error";

export interface HomeModelStatus {
  kind: HomeModelStatusKind;
  /** True while the local text model is not yet usable for chat. */
  blocksSend: boolean;
  /** Download completion 0–100, or null when not downloading. */
  percent: number | null;
  /** Estimated milliseconds remaining for the active download, or null. */
  etaMs: number | null;
  /** Display name of the assigned model, when known. */
  modelName: string | null;
  /** Distinct error messages from failed downloads / activation. */
  errors: string[];
}

function maxOrNull(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function firstModelName(slots: LocalInferenceSlotReadiness[]): string | null {
  for (const slot of slots) {
    if (slot.displayName) return slot.displayName;
  }
  return null;
}

/**
 * Collapse the per-slot local-inference readiness into a single status for the
 * home avatar surface: whether a local text model is required, whether it is
 * still downloading/loading, and whether chat should be gated until ready.
 *
 * When no local text slot is assigned (cloud/remote/hybrid runtimes), the
 * status is `not-required` and never blocks send.
 */
export function deriveHomeModelStatus(
  readiness: LocalInferenceReadiness,
): HomeModelStatus {
  const assigned = Object.values(readiness.slots).filter(
    (slot) => slot.assigned,
  );
  const modelName = firstModelName(assigned);

  if (assigned.length === 0) {
    return {
      kind: "not-required",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName: null,
      errors: [],
    };
  }

  if (assigned.every((slot) => slot.ready)) {
    return {
      kind: "ready",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName,
      errors: [],
    };
  }

  const failed = assigned.filter(
    (slot) => slot.state === "failed" || slot.state === "cancelled",
  );
  if (failed.length > 0) {
    return {
      kind: "error",
      blocksSend: true,
      percent: null,
      etaMs: null,
      modelName,
      errors: [...new Set(failed.flatMap((slot) => slot.errors))],
    };
  }

  const downloading = assigned.filter((slot) => slot.state === "downloading");
  if (downloading.length > 0) {
    const percents = downloading
      .map((slot) => slot.download.percent)
      .filter((value): value is number => value !== null);
    const etas = downloading
      .map((slot) => slot.download.etaMs)
      .filter((value): value is number => value !== null);
    return {
      kind: "downloading",
      blocksSend: true,
      percent: maxOrNull(percents),
      etaMs: maxOrNull(etas),
      modelName,
      errors: [],
    };
  }

  const missing = assigned.some(
    (slot) => slot.state === "missing" || slot.state === "unassigned",
  );
  if (missing) {
    return {
      kind: "missing",
      blocksSend: true,
      percent: null,
      etaMs: null,
      modelName,
      errors: [],
    };
  }

  // Downloaded to disk but not yet activated by the runtime.
  return {
    kind: "loading",
    blocksSend: true,
    percent: 100,
    etaMs: null,
    modelName,
    errors: [],
  };
}
