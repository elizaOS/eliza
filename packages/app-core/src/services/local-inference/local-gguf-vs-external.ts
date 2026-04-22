/**
 * Decides when to keep `milady-local-inference` out of the router candidate set
 * even though a GGUF is assigned or already loaded.
 *
 * **WHY:** Ollama / LM Studio / vLLM typically hold a large model in RAM/VRAM on
 * the same machine. Loading Milady’s in-process llama.cpp GGUF at the same time
 * doubles resident weights and often OOMs or thrashes. When probes show an
 * external stack is **reachable with models** and the runtime already has
 * **another** handler for this slot (cloud or those plugins), we default to
 * that path unless the user explicitly prefers Milady local or opts out via env.
 */

import type { HandlerRegistration } from "./handler-registry";
import type { RoutingPreferences } from "./routing-preferences";
import type { AgentModelSlot } from "./types";

export const MILADY_LOCAL_INFERENCE_PROVIDER = "milady-local-inference";

export function prefersMiladyLocalInferenceSlot(
  prefs: RoutingPreferences,
  slot: AgentModelSlot,
): boolean {
  const raw = prefs.preferredProvider[slot];
  if (typeof raw !== "string") return false;
  return raw.trim().toLowerCase() === MILADY_LOCAL_INFERENCE_PROVIDER;
}

/** Opt out of suppression so power users can run external + in-app GGUF. */
export function allowLocalGgufAlongsideExternalLlm(): boolean {
  return (
    process.env.MILADY_ALLOW_LOCAL_GGUF_WITH_EXTERNAL_LLM?.trim() === "1" ||
    process.env.ELIZA_ALLOW_LOCAL_GGUF_WITH_EXTERNAL_LLM?.trim() === "1"
  );
}

export function hasAlternativeInferenceProviders(
  candidates: HandlerRegistration[],
): boolean {
  return candidates.some((c) => c.provider !== MILADY_LOCAL_INFERENCE_PROVIDER);
}

/**
 * When true, `milady-local-inference` must not be offered to the policy engine
 * for this slot (avoids routing new work to in-app GGUF while an external local
 * LLM is already serving the machine).
 */
export function computeSuppressMiladyLocalGguf(params: {
  candidates: HandlerRegistration[];
  slot: AgentModelSlot;
  prefs: RoutingPreferences;
  /** Model already resident in the llama.cpp engine or slot assignment set. */
  hasExplicitLocalIntent: boolean;
  /** Cached probe: `routerInferenceReady` on hub rows (Ollama uses /api/ps when supported). */
  externalLocalLlmReady: boolean;
}): boolean {
  if (!params.hasExplicitLocalIntent) return false;
  if (allowLocalGgufAlongsideExternalLlm()) return false;
  if (prefersMiladyLocalInferenceSlot(params.prefs, params.slot)) return false;
  if (!hasAlternativeInferenceProviders(params.candidates)) return false;
  return params.externalLocalLlmReady;
}
