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
import { logger, ModelType } from "@elizaos/core";
import { readEffectiveAssignments } from "./assignments";
import { localInferenceEngine } from "./engine";
import type { HandlerRegistration } from "./handler-registry";
import { handlerRegistry } from "./handler-registry";
import { policyEngine } from "./routing-policy";
import {
  DEFAULT_ROUTING_POLICY,
  readRoutingPreferences,
} from "./routing-preferences";
import { AGENT_MODEL_SLOTS, type AgentModelSlot } from "./types";

export const ROUTER_PROVIDER = "eliza-router";
/**
 * Max safe integer keeps us at the top even if a plugin registers with
 * a very high priority. If someone deliberately wants to outrank us,
 * they can register with Infinity — unlikely in practice.
 */
const ROUTER_PRIORITY = Number.MAX_SAFE_INTEGER;

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
  }
}

function modelTypeToSlot(modelType: string): AgentModelSlot | null {
  for (const slot of AGENT_MODEL_SLOTS) {
    if (slotToModelType(slot) === modelType) return slot;
  }
  return null;
}

function shouldForceLocalInference(
  policy: string,
  preferredProvider: string | null,
): boolean {
  return policy === "manual" && preferredProvider === "eliza-local-inference";
}

export function filterUnavailableLocalInferenceCandidates(
  candidates: HandlerRegistration[],
  localInferenceAvailable: boolean,
  forceLocalInference: boolean,
): HandlerRegistration[] {
  if (forceLocalInference || localInferenceAvailable) {
    return candidates;
  }

  return candidates.filter(
    (candidate) => candidate.provider !== "eliza-local-inference",
  );
}

export async function filterUnavailableLocalInference(
  slot: AgentModelSlot,
  policy: string,
  preferredProvider: string | null,
  candidates: HandlerRegistration[],
): Promise<HandlerRegistration[]> {
  const hasLocalInference = candidates.some(
    (candidate) => candidate.provider === "eliza-local-inference",
  );
  if (!hasLocalInference) {
    return candidates;
  }

  const assignments = await readEffectiveAssignments();
  return filterUnavailableLocalInferenceCandidates(
    candidates,
    Boolean(assignments[slot]) || localInferenceEngine.hasLoadedModel(),
    shouldForceLocalInference(policy, preferredProvider),
  );
}

function makeRouterHandler(slot: AgentModelSlot): AnyHandler {
  return async (runtime, params) => {
    const modelType = slotToModelType(slot);
    if (!modelType) {
      throw new Error(`[router] Unknown agent slot: ${slot}`);
    }

    // Read the user's policy for this slot. Absent = local-first fallback.
    const prefs = await readRoutingPreferences();
    const policy = prefs.policy[slot] ?? DEFAULT_ROUTING_POLICY;
    const preferred = prefs.preferredProvider[slot] ?? null;

    // Ask the policy engine which handler to dispatch to. For automatic
    // policies, honor the documented fallback behaviour: if the selected
    // provider throws, try the next eligible provider instead of surfacing a
    // local/model-specific failure while cloud providers are available.
    const candidates = await filterUnavailableLocalInference(
      slot,
      policy,
      preferred,
      handlerRegistry.getForTypeExcluding(modelType, ROUTER_PROVIDER),
    );
    const failedProviders = new Set<string>();
    let lastError: unknown = null;

    while (true) {
      const remaining = candidates.filter(
        (candidate) => !failedProviders.has(candidate.provider),
      );
      const pick = policyEngine.pickProvider({
        modelType,
        policy,
        preferredProvider: preferred,
        candidates: remaining,
        selfProvider: ROUTER_PROVIDER,
      });

      if (!pick) {
        if (lastError) {
          throw lastError;
        }
        throw new Error(
          `[router] No provider registered for ${slot}. Configure a cloud provider, enable local inference, or pair a device.`,
        );
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
        // Record the timing even on failure so "fastest" doesn't silently
        // prefer providers that error out fast.
        policyEngine.recordLatency(
          pick.provider,
          modelType,
          Date.now() - start,
        );

        const manualPreferred =
          policy === "manual" &&
          preferred !== null &&
          pick.provider === preferred;
        const hasAlternative = remaining.some(
          (candidate) => candidate.provider !== pick.provider,
        );
        if (manualPreferred || !hasAlternative) {
          throw err;
        }

        failedProviders.add(pick.provider);
        lastError = err;
        logger.warn(
          `[router] Provider ${pick.provider} failed for ${slot}; trying fallback provider (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
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
