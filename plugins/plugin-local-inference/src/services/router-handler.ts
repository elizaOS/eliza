/**
 * Top-priority router handler.
 *
 * Registers a model handler for every `AgentModelSlot` at priority
 * `Number.MAX_SAFE_INTEGER`, which guarantees the runtime dispatches to
 * us first. At dispatch time we:
 *
 *   1. Read the user's per-slot policy + preferred-provider choice from
 *      `routing-preferences.ts`.
 *   2. Ask the `policyEngine` to pick a provider from the runtime's live
 *      model registry (excluding ourselves).
 *   3. Invoke that provider's registered handler directly — bypassing
 *      `runtime.useModel` which would recurse into us.
 *   4. Record the observed latency so later "fastest" picks have data.
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
 *   1. **Local (`eliza-local-inference`)** — tier-aware Eliza-1 voice,
 *      using the ordered `ELIZA_1_VOICE_BACKENDS` policy in
 *      `@elizaos/shared/local-inference/catalog` (OmniVoice first where
 *      bundled, Kokoro fallback where bundled). Always preferred when
 *      available.
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
 * the fused Gemma ASR path when the active bundle stages eligible ASR
 * artifacts (no whisper.cpp fallback).
 *
 * Users can override this per slot via the routing-preferences settings
 * panel (`prefer-local` ↔ `manual` + explicit `preferredProvider`).
 */

import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import {
	logger,
	ModelType,
	NoModelProviderConfiguredError,
} from "@elizaos/core";
import { readEffectiveAssignments } from "./assignments";
import { classifyDeviceTier, type DeviceTierAssessment } from "./device-tier";
import { localInferenceEngine } from "./engine";
import { handlerRegistry } from "./handler-registry";
import { probeHardware } from "./hardware";
import { type LiveDeviceSignals, readLiveDeviceSignals } from "./live-signals";
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

/**
 * The device-tier assessment drives the `auto` policy (and softly hints
 * `prefer-local`). Probing hardware is cheap but not free, so cache the
 * assessment for a short window — long enough to avoid re-probing on every
 * model call, short enough that the live free-RAM demotion stays roughly
 * current. The live thermal / throughput signals are read fresh per call (they
 * change fast and are cheap to read), not cached.
 */
const DEVICE_TIER_TTL_MS = 30_000;
let cachedDeviceTier: { at: number; assessment: DeviceTierAssessment } | null =
	null;

async function resolveDeviceTier(): Promise<DeviceTierAssessment | null> {
	const now = Date.now();
	if (cachedDeviceTier && now - cachedDeviceTier.at < DEVICE_TIER_TTL_MS) {
		return cachedDeviceTier.assessment;
	}
	const probe = await probeHardware();
	const assessment = classifyDeviceTier(probe);
	cachedDeviceTier = { at: now, assessment };
	return assessment;
}

function readBooleanEnv(name: string): boolean {
	const value =
		typeof process !== "undefined" ? process.env[name]?.trim() : undefined;
	if (!value) {
		return false;
	}
	return value === "1" || value.toLowerCase() === "true";
}

/**
 * Runtime's registerModel type, narrowed for our use. The core signature
 * lets the handler return any model type; for routing we only care that
 * we can call it and await a result.
 */
type AnyHandler = (
	runtime: IAgentRuntime,
	params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * A dispatchable candidate: registration metadata plus the live handler read
 * from the runtime's model registry at dispatch time. The router selects a
 * provider by policy and invokes its handler directly — bypassing
 * `runtime.useModel`, which would re-enter the router and double-apply
 * per-call processing (model-settings merge, streaming setup, PII swap).
 */
interface RoutableCandidate {
	modelType: string;
	provider: string;
	priority: number;
	handler: AnyHandler;
}

function slotToModelType(slot: AgentModelSlot): string | undefined {
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
	// Keep the local-inference candidate even when no text model is assigned/loaded
	// when the policy guarantees on-device routing: an explicit manual pin, or the
	// `local-only` policy (which must never fall back to cloud).
	if (policy === "local-only") return true;
	return policy === "manual" && preferredProvider === "eliza-local-inference";
}

/**
 * Read the live model registry off the runtime and return the dispatchable
 * candidates (with handlers) for a model type, excluding the router itself.
 * This is the router's dispatch source: `getModelRegistrations()` exposes the
 * registry as handler-free metadata, but the router must invoke the picked
 * provider's handler directly, so it reads the one live handler it needs here.
 */
function getRuntimeModelCandidates(
	runtime: IAgentRuntime,
	modelType: string,
): RoutableCandidate[] {
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
				handler: AnyHandler;
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
			handler: entry.handler,
		}))
		.sort((a, b) => b.priority - a.priority);
}

export function filterUnavailableLocalInferenceCandidates(
	candidates: RoutableCandidate[],
	localInferenceAvailable: boolean,
	forceLocalInference: boolean,
): RoutableCandidate[] {
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
	candidates: RoutableCandidate[],
): Promise<RoutableCandidate[]> {
	// TTS is self-sufficient: its handler calls ensureActiveBundleVoiceReady()
	// internally and can use the Kokoro-only bridge on demand.
	if (slot === "TEXT_TO_SPEECH") {
		return candidates;
	}

	if (slot === "TRANSCRIPTION") {
		return filterUnavailableLocalInferenceCandidates(
			candidates,
			await localInferenceEngine.canTranscribeLocally(),
			shouldForceLocalInference(policy, preferredProvider),
		);
	}

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

		// Read the user's policy for this slot. The per-slot policy is canonical;
		// when absent it falls back to the local-first default. ELIZA_LOCAL_ONLY
		// is retained for back-compat only: it sets the *global default* to
		// `local-only`, but an explicit per-slot policy always wins.
		const prefs = await readRoutingPreferences();
		const globalDefault: RoutingPolicy = readBooleanEnv("ELIZA_LOCAL_ONLY")
			? "local-only"
			: DEFAULT_ROUTING_POLICY;
		const policy: RoutingPolicy = prefs.policy[slot] ?? globalDefault;
		const preferred = prefs.preferredProvider[slot] ?? null;

		// Ask the policy engine which handler to dispatch to. For automatic
		// policies, honor the documented fallback behaviour: if the selected
		// provider throws, try the next eligible provider instead of surfacing a
		// local/model-specific failure while cloud providers are available.
		// Candidates (with live handlers) come straight from the runtime's model
		// registry, excluding the router itself.
		const candidates = await filterUnavailableLocalInference(
			slot,
			policy,
			preferred,
			getRuntimeModelCandidates(runtime, modelType),
		);

		// Only the capability-aware policies need the hardware assessment + live
		// signals. The tier is cached; the live signals are read fresh.
		let deviceTier: DeviceTierAssessment | null = null;
		let liveSignals: LiveDeviceSignals | null = null;
		if (policy === "auto" || policy === "prefer-local") {
			deviceTier = await resolveDeviceTier();
		}
		if (policy === "auto") {
			liveSignals = readLiveDeviceSignals();
		}

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
				slot,
				deviceTier,
				liveSignals,
			});

			if (!pick) {
				if (lastError) {
					throw lastError;
				}
				throw new NoModelProviderConfiguredError(
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
				logger.info(
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
export interface RouterInstallOptions {
	skipSlots?: readonly AgentModelSlot[];
}

export function installRouterHandler(
	runtime: AgentRuntime,
	options: RouterInstallOptions = {},
): void {
	const rt = runtime as AgentRuntime & {
		registerModel?: (
			modelType: string,
			handler: AnyHandler,
			provider: string,
			priority?: number,
		) => void;
	};
	if (typeof rt.registerModel !== "function") return;

	const skippedSlots = new Set(options.skipSlots ?? []);
	for (const slot of AGENT_MODEL_SLOTS) {
		if (skippedSlots.has(slot)) continue;
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
