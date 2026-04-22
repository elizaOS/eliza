import type { ExternalLlmRuntimeRow } from "./types";

/**
 * Coarse hub probe lifecycle for UI badges (mirrors `routerInferenceReady` +
 * reachability from `external-llm-runtime` probes).
 */
export type ExternalHubProbeStatus = "not_detected" | "detected" | "working";

export function getExternalHubProbeStatus(
  row: ExternalLlmRuntimeRow,
): ExternalHubProbeStatus {
  if (!row.reachable) return "not_detected";
  if (row.routerInferenceReady === true) return "working";
  return "detected";
}

export function externalHubProbeStatusTitle(
  status: ExternalHubProbeStatus,
): string {
  switch (status) {
    case "not_detected":
      return "Not detected";
    case "detected":
      return "Detected";
    case "working":
      return "Working";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Tailwind classes for a small pill badge (border + soft fill + text). */
export function externalHubProbeStatusBadgeClass(
  status: ExternalHubProbeStatus,
): string {
  switch (status) {
    case "not_detected":
      return "border-danger/45 bg-danger/12 text-danger";
    case "detected":
      return "border-amber-500/55 bg-amber-500/14 text-amber-950 dark:border-amber-400/45 dark:bg-amber-400/12 dark:text-amber-50";
    case "working":
      return "border-emerald-600/45 bg-emerald-600/12 text-emerald-950 dark:border-emerald-400/45 dark:bg-emerald-500/14 dark:text-emerald-50";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * Short pill text: **Idle** when the stack is up and models exist but the probe
 * shows no runners (Ollama `/api/ps` = 0, LM Studio `loaded_instances` = 0).
 * “Working” still means **`routerInferenceReady`** (hot enough for the router
 * to treat external local LLM as active).
 */
export function getExternalHubProbeBadgeLabel(
  row: ExternalLlmRuntimeRow,
): string {
  const s = getExternalHubProbeStatus(row);
  if (s === "not_detected") return externalHubProbeStatusTitle(s);
  if (s === "working") return externalHubProbeStatusTitle(s);
  if (
    row.id === "ollama" &&
    row.hasDownloadedModels &&
    typeof row.ollamaRunningModelCount === "number" &&
    row.ollamaRunningModelCount === 0
  ) {
    return "Idle";
  }
  if (
    row.id === "lmstudio" &&
    row.hasDownloadedModels &&
    typeof row.lmStudioLoadedInstanceCount === "number" &&
    row.lmStudioLoadedInstanceCount === 0
  ) {
    return "Idle";
  }
  return externalHubProbeStatusTitle("detected");
}

export function getExternalHubProbeBadgeTooltip(
  row: ExternalLlmRuntimeRow,
): string {
  const s = getExternalHubProbeStatus(row);
  if (s === "working") {
    return "Reachable and router-ready: external local LLM is treated as active (may route away from in-app GGUF when policy allows).";
  }
  if (s === "not_detected") {
    return row.error?.trim()
      ? row.error
      : "Unreachable or probe failed at this URL.";
  }
  if (row.id === "ollama") {
    if (
      row.hasDownloadedModels &&
      typeof row.ollamaRunningModelCount === "number" &&
      row.ollamaRunningModelCount === 0
    ) {
      return "Ollama lists models in /api/tags, but /api/ps reports 0 loaded in RAM. Pull or run a model so it stays resident (e.g. ollama run <name>) — then this becomes Working. Until then the router keeps Milady GGUF so two large stacks are not both assumed hot.";
    }
    return "Reachable but not router-ready yet (see status below).";
  }
  if (row.id === "lmstudio") {
    if (
      row.hasDownloadedModels &&
      typeof row.lmStudioLoadedInstanceCount === "number" &&
      row.lmStudioLoadedInstanceCount === 0
    ) {
      return "LM Studio lists models on /v1/models, but native loaded_instances is 0 — load a model in the LM Studio UI for Working.";
    }
    return "Reachable but not router-ready yet (see status below).";
  }
  if (row.id === "vllm" || row.id === "jan") {
    return "Reachable; /v1/models did not satisfy router-ready (see status below).";
  }
  return "Reachable; not router-ready for this stack.";
}
