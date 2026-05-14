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
 *   5. On handler failure: retry the next eligible provider in priority
 *      order until exhausted (except in `manual` mode with an explicit
 *      preferred provider — that throws verbatim).
 *
 * If no other handler exists we throw a clear error rather than return
 * garbage — the caller is meant to see "no provider configured" so they
 * know to set one up.
 *
 * Because the router sits at the top of the priority stack, the user's
 * preference is always authoritative regardless of what plugins register
 * at lower priorities. This is the mechanism that unifies cloud + local
 * + device-bridge routing from one settings panel.
 *
 * ## TTS routing precedence (`TEXT_TO_SPEECH` slot)
 *
 * The default per-slot policy is `prefer-local` (see
 * `DEFAULT_ROUTING_POLICY` in `routing-preferences.ts`), which the
 * policyEngine implements by short-circuiting to whichever candidate
 * has provider `eliza-local-inference` / `capacitor-llama` /
 * `eliza-device-bridge`. So even though `plugin-elizacloud` registers
 * its TTS handler at plugin priority 50 (higher than the default 0 of
 * direct providers like ElevenLabs / OpenAI / Groq / Edge-TTS), the
 * router prefers local first when local is registered AND
 * `local-inference` has a TTS-capable handler.
 *
 * Documented routing precedence for `TEXT_TO_SPEECH`:
 *
 *   1. **Local (`eliza-local-inference`)** — Kokoro on small tiers,
 *      OmniVoice on large tiers, per `ELIZA_1_VOICE_BACKENDS` in
 *      `@elizaos/shared/local-inference/catalog`. Selection is
 *      tier-aware via `services/voice/kokoro/runtime-selection.ts`.
 *      Always preferred when available.
 *   2. **Eliza Cloud (`elizacloud`)** — managed cloud proxy. Picked when
 *      local is unavailable. Throws `CloudTtsUnavailableError` when
 *      cloud isn't connected, which the loop above catches and falls
 *      through to step 3.
 *   3. **ElevenLabs (`elevenlabs`)** — direct API key path.
 *   4. **OpenAI (`openai`)** — direct API key path.
 *   5. **Groq (`groq`)** — direct API key path.
 *   6. **Edge-TTS (`edge-tts`)** — free Microsoft Edge endpoint, no key.
 *
 * Same precedence applies to `TRANSCRIPTION`, with the local side using
 * Qwen3-ASR via the fused libelizainference (no whisper.cpp; see
 * `plugin-local-inference/native/AGENTS.md` §1).
 *
 * Users can override this per slot via the routing-preferences settings
 * panel (`prefer-local` ↔ `manual` + explicit `preferredProvider`).
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
	type RoutingPolicy,
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
type LocalRoutableSlot = AgentModelSlot;
const LOCAL_ROUTABLE_SLOTS: readonly LocalRoutableSlot[] = AGENT_MODEL_SLOTS;

/**
 * Runtime's registerModel type, narrowed for our use. The core signature
 * lets the handler return any model type; for routing we only care that
 * we can call it and await a result.
 */
type AnyHandler = (
	runtime: IAgentRuntime,
	params: Record<string, unknown>,
) => Promise<unknown>;

function slotToModelType(slot: LocalRoutableSlot): string | undefined {
	switch (slot) {
		case "TEXT_SMALL":
			return ModelType.TEXT_SMALL;
		case "TEXT_LARGE":
			return ModelType.TEXT_LARGE;
		case "TEXT_EMBEDDING":
			return ModelType.TEXT_EMBEDDING;
		case "TEXT_TO_SPEECH":
			return ModelType.TEXT_TO_SPEECH;
		case "TRANSCRIPTION":
			return ModelType.TRANSCRIPTION;
		case "IMAGE_DESCRIPTION":
			return ModelType.IMAGE_DESCRIPTION;
	}
}

function modelTypeToSlot(modelType: string): LocalRoutableSlot | null {
	for (const slot of LOCAL_ROUTABLE_SLOTS) {
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

function getRuntimeModelCandidates(
	runtime: IAgentRuntime,
	modelType: string,
): HandlerRegistration[] {
	const models = (runtime as { models?: unknown }).models;
	if (!(models instanceof Map)) return [];
	const registrations = models.get(modelType);
	if (!Array.isArray(registrations)) return [];
	return registrations
		.filter(
			(
				entry,
			): entry is {
				provider: string;
				priority?: number;
				handler: HandlerRegistration["handler"];
			} =>
				entry &&
				typeof entry === "object" &&
				typeof (entry as { provider?: unknown }).provider === "string" &&
				(entry as { provider: string }).provider !== ROUTER_PROVIDER &&
				typeof (entry as { handler?: unknown }).handler === "function",
		)
		.map((entry) => ({
			modelType,
			provider: entry.provider,
			priority: typeof entry.priority === "number" ? entry.priority : 0,
			registeredAt: "runtime-introspection",
			handler: entry.handler,
		}))
		.sort((a, b) => b.priority - a.priority);
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
	slot: LocalRoutableSlot,
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
	const assigned =
		slot === "IMAGE_DESCRIPTION" ? null : assignments[slot as AgentModelSlot];
	return filterUnavailableLocalInferenceCandidates(
		candidates,
		Boolean(assigned) || localInferenceEngine.hasLoadedModel(),
		shouldForceLocalInference(policy, preferredProvider),
	);
}

function makeRouterHandler(slot: LocalRoutableSlot): AnyHandler {
	return async (runtime, params) => {
		const modelType = slotToModelType(slot);
		if (!modelType) {
			throw new Error(`[router] Unknown agent slot: ${slot}`);
		}

		// Read the user's policy for this slot. Absent = local-first fallback.
		const prefs = await readRoutingPreferences();
		const policy =
			(prefs.policy as Partial<Record<LocalRoutableSlot, RoutingPolicy>>)[
				slot
			] ?? DEFAULT_ROUTING_POLICY;
		const preferred =
			(prefs.preferredProvider as Partial<Record<LocalRoutableSlot, string>>)[
				slot
			] ?? null;

		// Ask the policy engine which handler to dispatch to. For automatic
		// policies, honor the documented fallback behaviour: if the selected
		// provider throws, try the next eligible provider instead of surfacing a
		// local/model-specific failure while cloud providers are available.
		const registeredCandidates = handlerRegistry.getForTypeExcluding(
			modelType,
			ROUTER_PROVIDER,
		);
		const candidates = await filterUnavailableLocalInference(
			slot,
			policy,
			preferred,
			registeredCandidates.length > 0
				? registeredCandidates
				: getRuntimeModelCandidates(runtime, modelType),
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

	for (const slot of LOCAL_ROUTABLE_SLOTS) {
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
	slot: LocalRoutableSlot;
	modelType: string;
	candidates: Array<{
		provider: string;
		priority: number;
	}>;
}> {
	const out: ReturnType<typeof describeCurrentRouting> = [];
	for (const slot of LOCAL_ROUTABLE_SLOTS) {
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
