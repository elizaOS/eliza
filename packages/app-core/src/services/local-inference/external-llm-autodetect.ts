/**
 * Single place for “external local LLM” autodetect: probe order, readiness
 * predicate (matches `isExternalLocalLlmInferenceReady`), and UI copy for the
 * hub’s Automatic option. Keeps router + settings UI aligned.
 */

import { sortExternalRuntimes } from "./sort-external-runtimes";
import type { ExternalLlmRuntimeRow } from "./types";

/**
 * Probe result array order — must stay in sync with `detectExternalLlmBackends`
 * assembly (`Promise.all` → ordered list).
 */
export const EXTERNAL_LLM_PROBE_ORDER: readonly ExternalLlmRuntimeRow["id"][] =
  ["ollama", "lmstudio", "vllm", "jan"] as const;

/** Row predicate shared with `isExternalLocalLlmInferenceReady`. */
export function externalLocalLlmRowReadyForGguf(
  row: ExternalLlmRuntimeRow,
): boolean {
  if (!row.reachable) return false;
  if (typeof row.routerInferenceReady === "boolean") {
    return row.routerInferenceReady;
  }
  return row.hasDownloadedModels || row.models.length > 0;
}

export interface ResolvedExternalLlmAutodetectUi {
  /** `<option value="any">` label text. */
  automaticSelectLabel: string;
  /** Satisfies readiness, in `EXTERNAL_LLM_PROBE_ORDER` (evaluation order). */
  qualifyingRowsInProbeOrder: ExternalLlmRuntimeRow[];
}

/**
 * Derives hub UI strings and structured state from the latest probe snapshot.
 */
export function resolveExternalLlmAutodetectUi(
  backends: ExternalLlmRuntimeRow[],
): ResolvedExternalLlmAutodetectUi {
  const qualifying = EXTERNAL_LLM_PROBE_ORDER.map((id) =>
    backends.find((r) => r.id === id),
  ).filter((r): r is ExternalLlmRuntimeRow =>
    Boolean(r && externalLocalLlmRowReadyForGguf(r)),
  );

  let automaticSelectLabel: string;
  if (qualifying.length === 1) {
    automaticSelectLabel = `Automatic — ${qualifying[0]?.displayName} (this stack sets “external ready”)`;
  } else if (qualifying.length > 1) {
    const [first] = qualifying;
    automaticSelectLabel = `Automatic — ${first.displayName} leads probe order (+${qualifying.length - 1} more ready)`;
  } else {
    const sorted = sortExternalRuntimes(backends);
    const present = sorted.filter(
      (b) => b.reachable && (b.hasDownloadedModels || b.models.length > 0),
    );
    if (present.length === 1) {
      automaticSelectLabel = `Automatic — ${present[0]?.displayName} (idle — load a run to qualify)`;
    } else if (present.length > 1) {
      const [head] = present;
      automaticSelectLabel = `Automatic — ${head.displayName} +${present.length - 1} idle`;
    } else {
      const reachable = sorted.filter((b) => b.reachable);
      if (reachable.length === 1) {
        automaticSelectLabel = `Automatic — ${reachable[0]?.displayName} (reachable — add a model)`;
      } else if (reachable.length > 1) {
        const [head] = reachable;
        automaticSelectLabel = `Automatic — ${head.displayName} +${reachable.length - 1} reachable`;
      } else {
        automaticSelectLabel =
          "Automatic — no reachable stacks (check probe URLs)";
      }
    }
  }

  return {
    automaticSelectLabel,
    qualifyingRowsInProbeOrder: qualifying,
  };
}
