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
  /** True while the local text model is unavailable for chat. */
  blocksSend: boolean;
  /** Download completion 0–100, or null when not downloading. */
  percent: number | null;
  /** Estimated milliseconds remaining for the active download, or null. */
  etaMs: number | null;
  /** Display name of the assigned model, when known. */
  modelName: string | null;
  /**
   * Id of the assigned model (`assignedModelId`), when known — the handle the
   * in-chat status card's cancel/retry controls pass to the downloads API.
   * Optional: `not-required` and mock/test statuses carry no model.
   */
  modelId?: string | null;
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

function firstModelId(slots: LocalInferenceSlotReadiness[]): string | null {
  for (const slot of slots) {
    if (slot.assignedModelId) return slot.assignedModelId;
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
  const modelId = firstModelId(assigned);

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
      modelId,
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
      modelId,
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
      modelId,
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
      modelId,
      errors: [],
    };
  }

  // Downloaded to disk and awaiting runtime activation.
  return {
    kind: "loading",
    blocksSend: true,
    percent: 100,
    etaMs: null,
    modelName,
    modelId,
    errors: [],
  };
}
