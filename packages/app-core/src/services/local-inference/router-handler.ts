/**
 * Top-priority router handler.
 *
 * Registers a model handler for every `AgentModelSlot` at priority
 * `Number.MAX_SAFE_INTEGER`, which guarantees the runtime dispatches to
 * us first. At dispatch time we:
 *
 *   1. Read the user's per-slot policy + preferred-provider choice from
 *      `routing-preferences.ts`.
 *   2. Ask the `policyEngine` to pick a provider from the handler
 *      registry's current set (excluding ourselves).
 *   3. Invoke that provider's original handler directly — bypassing
 *      `runtime.useModel` which would recurse into us.
 *   4. Record the observed latency so future "fastest" picks have data.
 *
 * If no other handler exists we throw a clear error rather than return
 * garbage — the caller is meant to see "no provider configured" so they
 * know to set one up.
 *
 * Because the router sits at the top of the priority stack, the user's
 * preference is always authoritative regardless of what plugins register
 * at lower priorities. This is the mechanism that unifies cloud + local
 * + device-bridge routing from one settings panel.
 */

import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { readAssignments } from "./assignments";
import { localInferenceEngine } from "./engine";
import {
  invalidateExternalLlmRuntimeCache,
  isExternalLocalLlmInferenceReady,
} from "./external-llm-runtime";
import { type HandlerRegistration, handlerRegistry } from "./handler-registry";
import {
  allowLocalGgufAlongsideExternalLlm,
  computeSuppressMiladyLocalGguf,
  hasAlternativeInferenceProviders,
  MILADY_LOCAL_INFERENCE_PROVIDER,
  prefersMiladyLocalInferenceSlot,
} from "./local-gguf-vs-external";
import {
  shouldAttemptHotplugRetry,
  shouldInvalidateExternalProbeCache,
} from "./routing-hotplug-recovery";
import { policyEngine } from "./routing-policy";
import {
  type RoutingPreferences,
  readRoutingPreferences,
} from "./routing-preferences";
import { AGENT_MODEL_SLOTS, type AgentModelSlot } from "./types";

export const ROUTER_PROVIDER = "milady-router";
/**
 * Max safe integer keeps us at the top even if a plugin registers with
 * a very high priority. If someone deliberately wants to outrank us,
 * they can register with Infinity — unlikely in practice.
 */
const ROUTER_PRIORITY = Number.MAX_SAFE_INTEGER;
/** LM Studio / Ollama vanish mid-session; try other handlers after probe refresh. */
const ROUTER_HOTPLUG_MAX_ATTEMPTS = 8;

/**
 * Runtime's registerModel type, narrowed for our use. The core signature
 * lets the handler return any model type; for routing we only care that
 * we can call it and await a result.
 */
type AnyHandler = (
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
) => Promise<unknown>;

function slotToModelType(slot: AgentModelSlot): string | undefined {
  switch (slot) {
    case "TEXT_SMALL":
      return ModelType.TEXT_SMALL;
    case "TEXT_LARGE":
      return ModelType.TEXT_LARGE;
    case "TEXT_EMBEDDING":
      return ModelType.TEXT_EMBEDDING;
    case "OBJECT_SMALL":
      return ModelType.OBJECT_SMALL;
    case "OBJECT_LARGE":
      return ModelType.OBJECT_LARGE;
  }
}

function modelTypeToSlot(modelType: string): AgentModelSlot | null {
  for (const slot of AGENT_MODEL_SLOTS) {
    if (slotToModelType(slot) === modelType) return slot;
  }
  return null;
}

/**
 * Shapes which handlers the policy engine may pick for this slot.
 *
 * 1. **No in-app GGUF intent (nothing loaded, no assignment):** never offer
 *    `milady-local-inference` — otherwise "cheapest" picks $0 local and every
 *    TEXT_* call fails when no model is installed.
 * 2. **In-app GGUF intent but external local LLM autodetected:** when Ollama /
 *    LM Studio / vLLM probes as reachable with models and another handler exists
 *    for this slot, drop Milady local so we do not stack two huge residents on
 *    one machine. Override: set preferred provider to `milady-local-inference`,
 *    or `MILADY_ALLOW_LOCAL_GGUF_WITH_EXTERNAL_LLM=1` / `ELIZA_ALLOW_*`.
 *
 * **WHY autodetect:** Probes are the same lightweight signal the hub already
 * uses; we only suppress when there is a real alternative provider registered.
 * See `docs/runtime/self-hosted-llm-inference-whys.md` §4.
 */
async function filterExecutableLocalGgufCandidates(
  candidates: HandlerRegistration[],
  slot: AgentModelSlot,
  prefs: RoutingPreferences,
): Promise<HandlerRegistration[]> {
  const out: HandlerRegistration[] = [];
  const assignments = await readAssignments();
  const assignedId = assignments[slot];
  const hasExplicitLocalIntent =
    localInferenceEngine.hasLoadedModel() || Boolean(assignedId);

  const shouldProbeExternal =
    hasExplicitLocalIntent &&
    !allowLocalGgufAlongsideExternalLlm() &&
    !prefersMiladyLocalInferenceSlot(prefs, slot) &&
    hasAlternativeInferenceProviders(candidates);

  const externalFocus = prefs.externalLlmAutodetectFocus ?? "any";
  const externalReady = shouldProbeExternal
    ? await isExternalLocalLlmInferenceReady(externalFocus)
    : false;

  const suppressSecondLocal = computeSuppressMiladyLocalGguf({
    candidates,
    slot,
    prefs,
    hasExplicitLocalIntent,
    externalLocalLlmReady: externalReady,
  });
  const canUseLocalGguf = hasExplicitLocalIntent && !suppressSecondLocal;

  for (const c of candidates) {
    if (c.provider !== MILADY_LOCAL_INFERENCE_PROVIDER) {
      out.push(c);
      continue;
    }
    if (canUseLocalGguf) out.push(c);
  }
  return out;
}

function makeRouterHandler(slot: AgentModelSlot): AnyHandler {
  return async (runtime, params) => {
    const modelType = slotToModelType(slot);
    if (!modelType) {
      throw new Error(`[router] Unknown agent slot: ${slot}`);
    }

    // Read the user's policy for this slot. Absent = manual.
    const prefs = await readRoutingPreferences();
    const policy = prefs.policy[slot] ?? "manual";
    const preferred = prefs.preferredProvider[slot] ?? null;

    const rawCandidates = handlerRegistry.getForTypeExcluding(
      modelType,
      ROUTER_PROVIDER,
    );

    const triedProviders = new Set<string>();
    let lastError: unknown;

    for (let attempt = 0; attempt < ROUTER_HOTPLUG_MAX_ATTEMPTS; attempt++) {
      const remaining = rawCandidates.filter(
        (c) => !triedProviders.has(c.provider),
      );
      if (remaining.length === 0) {
        break;
      }

      const candidates = await filterExecutableLocalGgufCandidates(
        remaining,
        slot,
        prefs,
      );
      const pick = policyEngine.pickProvider({
        modelType,
        policy,
        preferredProvider: preferred,
        candidates,
        selfProvider: ROUTER_PROVIDER,
      });

      if (!pick) {
        break;
      }

      policyEngine.recordPick(pick.provider, modelType);
      const start = Date.now();
      try {
        const result = await pick.handler(runtime, params);
        policyEngine.recordLatency(
          pick.provider,
          modelType,
          Date.now() - start,
        );
        return result;
      } catch (err) {
        lastError = err;
        policyEngine.recordLatency(
          pick.provider,
          modelType,
          Date.now() - start,
        );
        triedProviders.add(pick.provider);

        if (shouldInvalidateExternalProbeCache(pick.provider, err)) {
          invalidateExternalLlmRuntimeCache();
          runtime.logger.debug(
            {
              src: "milady-router",
              modelType,
              slot,
              provider: pick.provider,
              attempt,
            },
            "Invalidated external LLM probe cache after hot-plug style failure; will re-pick providers",
          );
        }

        if (!shouldAttemptHotplugRetry(pick.provider, err)) {
          throw err;
        }
      }
    }

    if (lastError !== undefined) {
      throw lastError;
    }

    throw new Error(
      `[router] No model provider available for ${slot}. Add a cloud API key, ` +
        `set OLLAMA_BASE_URL (Ollama) or OPENAI_BASE_URL (LM Studio / vLLM / Jan + openai plugin), ` +
        `or activate a chat GGUF under Settings → Local models.`,
    );
  };
}

/**
 * Install the router as the top-priority handler for every slot.
 *
 * Idempotent per-runtime via the handler-registry's "last write wins"
 * behaviour — re-registering our handlers just refreshes them in place.
 * Called from `ensure-local-inference-handler.ts` after `handlerRegistry`
 * has been installed on the runtime.
 */
export function installRouterHandler(runtime: AgentRuntime): void {
  const rt = runtime as AgentRuntime & {
    registerModel?: (
      modelType: string,
      handler: AnyHandler,
      provider: string,
      priority?: number,
    ) => void;
  };
  if (typeof rt.registerModel !== "function") return;

  for (const slot of AGENT_MODEL_SLOTS) {
    const modelType = slotToModelType(slot);
    if (!modelType) continue;
    rt.registerModel(
      modelType,
      makeRouterHandler(slot),
      ROUTER_PROVIDER,
      ROUTER_PRIORITY,
    );
  }
}

/** Public helper — useful for diagnostics endpoints. */
export function describeCurrentRouting(): Array<{
  slot: AgentModelSlot;
  modelType: string;
  candidates: Array<{
    provider: string;
    priority: number;
  }>;
}> {
  const out: ReturnType<typeof describeCurrentRouting> = [];
  for (const slot of AGENT_MODEL_SLOTS) {
    const modelType = slotToModelType(slot);
    if (!modelType) continue;
    const candidates = handlerRegistry
      .getForTypeExcluding(modelType, ROUTER_PROVIDER)
      .map((c) => ({ provider: c.provider, priority: c.priority }));
    out.push({ slot, modelType, candidates });
  }
  return out;
}

// Re-export so the handler registry can tell whether it's looking at a
// recursive router registration when filtering.
export { modelTypeToSlot };
