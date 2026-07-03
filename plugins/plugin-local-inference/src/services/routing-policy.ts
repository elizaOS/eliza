/**
 * Policy engine + latency + cost tracking for cross-provider routing.
 *
 * The policy engine sits on top of the `handlerRegistry` and, given a
 * model type and a user-selected policy, decides which provider's handler
 * should serve the next request. The router-handler (registered at top
 * priority) calls `pickProvider` to make that decision.
 *
 * Policies:
 *   - manual       — honour `preferredProvider`; when no pref set, fall
 *                    through to the runtime's native priority order
 *                    (highest registered priority wins).
 *   - auto         — capability-driven: consult the device-tier assessment AND
 *                    the live device signals (thermal + decode throughput). Route
 *                    local only when the device can comfortably run the slot's
 *                    modality (text → `canRunLocalLm`, voice → `canRunLocalVoice`)
 *                    AND it is not currently throttled / below the TPS budget.
 *                    Otherwise pick the highest-priority cloud provider.
 *   - cheapest     — pick the provider with the lowest per-token cost.
 *   - fastest      — pick the provider with the lowest tracked p50 latency
 *                    (needs at least a few samples; falls back to native).
 *   - prefer-local — try local first; if it fails or has no handler,
 *                    fall through to the next-best non-local. A device that
 *                    cannot run the slot's modality softly demotes the local
 *                    pick so an unusable on-device path isn't forced.
 *   - local-only   — always on-device: never returns a cloud provider. When no
 *                    local handler is registered, returns `null` so the caller
 *                    surfaces "no local provider" instead of silently routing
 *                    to a paid API.
 *   - cloud-only   — always off-device: never returns a local provider. Returns
 *                    `null` when only local handlers exist.
 *   - round-robin  — distribute load evenly across eligible providers.
 *
 * Latency is tracked in a ring buffer per provider per model type. Cost
 * is a static table of published per-million-token rates; local providers
 * are $0. Neither is exact — the goal is "good enough to discriminate"
 * rather than dollar-accurate billing.
 */

import type { DeviceTierAssessment } from "./device-tier";
import type { LiveDeviceSignals } from "./live-signals";
import { liveSignalsDemoteLocal } from "./live-signals";
import type { RoutingPolicy } from "./routing-preferences";
import type { AgentModelSlot } from "./types";

/**
 * The minimal shape the policy engine needs to rank and select a provider. The
 * router passes candidates that also carry a live handler; the engine only ever
 * reads `provider` + `priority`, so it stays generic over the candidate type
 * and returns the exact candidate (handler included) it picked.
 */
export interface ProviderCandidate {
	provider: string;
	priority: number;
}

const RING_SIZE = 32;

/** Provider IDs that serve inference on-device (no network round-trip). */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
	"eliza-local-inference",
	"capacitor-llama",
	"eliza-device-bridge",
]);

function isLocalProvider(provider: string): boolean {
	return LOCAL_PROVIDERS.has(provider);
}

/** Voice slots use `canRunLocalVoice`; text slots use `canRunLocalLm`. */
const VOICE_SLOTS: ReadonlySet<AgentModelSlot> = new Set([
	"TEXT_TO_SPEECH",
	"TRANSCRIPTION",
]);

/**
 * The first registered local handler in priority order, or null. Prefers the
 * in-process / Capacitor backends over the device bridge, matching the
 * `prefer-local` precedence.
 */
function findLocalCandidate<C extends ProviderCandidate>(
	candidates: C[],
): C | null {
	const inProcess = candidates.find(
		(c) =>
			c.provider === "eliza-local-inference" ||
			c.provider === "capacitor-llama",
	);
	if (inProcess) return inProcess;
	return candidates.find((c) => c.provider === "eliza-device-bridge") ?? null;
}

/**
 * Whether the device can run this slot's modality locally *at all*, per the
 * static tier assessment. Voice slots gate on `canRunLocalVoice` (the ASR + TTS
 * budget is stricter than text); every other slot gates on `canRunLocalLm`.
 * This is the per-modality independence AC4 requires — one assessment can yield
 * local text + cloud voice (OKAY desktop) simultaneously.
 */
function modalityViableForSlot(
	assessment: DeviceTierAssessment,
	slot: AgentModelSlot | undefined,
): boolean {
	return slot !== undefined && VOICE_SLOTS.has(slot)
		? assessment.canRunLocalVoice
		: assessment.canRunLocalLm;
}

/**
 * Whether `auto` should default this slot to local: the modality must be viable
 * AND the device must be a generally local-first machine (recommended "local",
 * or a MAX/GOOD tier). A device that merely *can* run the modality but is steered
 * to cloud by the classifier does not get a local default.
 */
function tierFavoursLocalForSlot(
	assessment: DeviceTierAssessment | null,
	slot: AgentModelSlot | undefined,
): boolean {
	if (!assessment) return false;
	if (!modalityViableForSlot(assessment, slot)) return false;
	return (
		assessment.recommendedMode === "local" ||
		assessment.tier === "MAX" ||
		assessment.tier === "GOOD"
	);
}

interface LatencySample {
	durationMs: number;
	at: number;
}

class RingBuffer {
	private buf: LatencySample[] = [];
	push(sample: LatencySample): void {
		this.buf.push(sample);
		if (this.buf.length > RING_SIZE) this.buf.shift();
	}
	p50(): number | null {
		if (this.buf.length === 0) return null;
		const sorted = [...this.buf].map((s) => s.durationMs).sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)] ?? null;
	}
	size(): number {
		return this.buf.length;
	}
}

/**
 * Relative per-million-token costs. Keep conservative: the policy only
 * needs the order to be right for product defaults.
 * Local / device-bridge = 0 because the user already paid for the hardware.
 * Subscriptions get a small marginal cost, direct APIs sit above that,
 * and Eliza Cloud is last because managed fallback is the most expensive
 * path for the user.
 */
const COST_PER_MILLION_TOKENS: Partial<
	Record<string, { input: number; output: number }>
> = {
	"eliza-local-inference": { input: 0, output: 0 },
	"eliza-device-bridge": { input: 0, output: 0 },
	"capacitor-llama": { input: 0, output: 0 },
	"anthropic-subscription": { input: 0.1, output: 0.1 },
	"openai-codex": { input: 0.1, output: 0.1 },
	"openai-subscription": { input: 0.1, output: 0.1 },
	anthropic: { input: 3, output: 15 },
	openai: { input: 2.5, output: 10 },
	grok: { input: 5, output: 15 },
	google: { input: 1.25, output: 5 },
	"google-genai": { input: 1.25, output: 5 },
	moonshot: { input: 1.25, output: 5 },
	kimi: { input: 1.25, output: 5 },
	nearai: { input: 0.85, output: 3.3 },
	zai: { input: 1.25, output: 5 },
	glm: { input: 1.25, output: 5 },
	mistral: { input: 2, output: 6 },
	elizacloud: { input: 30, output: 60 },
};

interface ProviderStats {
	latency: Map<string /* modelType */, RingBuffer>;
	lastPicked: Map<string /* modelType */, number /* timestamp */>;
}

class PolicyEngine {
	private stats = new Map<string /* provider */, ProviderStats>();

	private statsFor(provider: string): ProviderStats {
		let s = this.stats.get(provider);
		if (!s) {
			s = { latency: new Map(), lastPicked: new Map() };
			this.stats.set(provider, s);
		}
		return s;
	}

	recordLatency(provider: string, modelType: string, durationMs: number): void {
		const s = this.statsFor(provider);
		let buf = s.latency.get(modelType);
		if (!buf) {
			buf = new RingBuffer();
			s.latency.set(modelType, buf);
		}
		buf.push({ durationMs, at: Date.now() });
	}

	recordPick(provider: string, modelType: string): void {
		this.statsFor(provider).lastPicked.set(modelType, Date.now());
	}

	p50(provider: string, modelType: string): number | null {
		return this.statsFor(provider).latency.get(modelType)?.p50() ?? null;
	}

	lastPicked(provider: string, modelType: string): number | null {
		return this.statsFor(provider).lastPicked.get(modelType) ?? null;
	}

	costOf(provider: string): number | null {
		const c = COST_PER_MILLION_TOKENS[provider];
		if (!c) return null;
		// Weighted sum (3:1 output:input is a typical chat ratio). Treat missing
		// output pricing as same as input.
		return c.input * 0.25 + c.output * 0.75;
	}

	/**
	 * Pick a provider for this (modelType, policy) given the candidate set.
	 * Returns the candidate the router-handler should dispatch to (handler
	 * included, since the type is preserved), or null if none are eligible.
	 *
	 * `preferredProvider` is only honoured for policy === "manual".
	 */
	pickProvider<C extends ProviderCandidate>(args: {
		modelType: string;
		policy: RoutingPolicy;
		preferredProvider: string | null;
		candidates: C[];
		/** Provider ID of the router itself — always excluded from candidates. */
		selfProvider: string;
		/**
		 * The agent slot being routed. Drives the per-modality `auto` gate:
		 * voice slots (`TEXT_TO_SPEECH` / `TRANSCRIPTION`) check
		 * `canRunLocalVoice`; every other slot checks `canRunLocalLm`.
		 */
		slot?: AgentModelSlot;
		/**
		 * Static device-capability assessment from `classifyDeviceTier()`.
		 * Consulted by `auto` (per-modality gate) and used as a soft hint by
		 * `prefer-local`. Null when the host hasn't probed hardware yet — `auto`
		 * then falls back to cloud.
		 */
		deviceTier?: DeviceTierAssessment | null;
		/**
		 * Live device signals (thermal + decode throughput). When the device is
		 * currently throttled or below the TPS budget, `auto` demotes a local
		 * pick to cloud even if the static tier favoured local. Null = no live
		 * demotion (the static decision stands).
		 */
		liveSignals?: LiveDeviceSignals | null;
	}): C | null {
		const eligible = args.candidates
			.filter((c) => c.provider !== args.selfProvider)
			.slice()
			// Defensive sort — real callers already sort, but test fixtures and
			// non-registry callers might not, and a silent "pick-wrong" would be
			// worse than the extra O(n log n).
			.sort((a, b) => b.priority - a.priority);
		if (eligible.length === 0) return null;

		switch (args.policy) {
			case "manual": {
				if (args.preferredProvider) {
					const match = eligible.find(
						(c) => c.provider === args.preferredProvider,
					);
					if (match) return match;
				}
				// Fallback: highest native priority.
				return eligible[0] ?? null;
			}
			case "auto": {
				// Capability-driven: route local only when the device can run this
				// slot's modality (per-modality gate: text → canRunLocalLm, voice →
				// canRunLocalVoice) AND it is not currently throttled / below the TPS
				// budget. Otherwise pick the highest-priority cloud provider.
				const local = findLocalCandidate(eligible);
				const tierFavours = tierFavoursLocalForSlot(
					args.deviceTier ?? null,
					args.slot,
				);
				const liveDemotes =
					args.liveSignals != null && liveSignalsDemoteLocal(args.liveSignals);
				if (local && tierFavours && !liveDemotes) {
					return local;
				}
				const cloud = eligible.find((c) => !isLocalProvider(c.provider));
				return cloud ?? eligible[0] ?? null;
			}
			case "local-only": {
				// Hard local guarantee: only ever return an on-device handler. When
				// none is registered we return null so the dispatch loop fails
				// closed — it never silently falls through to a cloud provider.
				// This is the per-slot canonical replacement for ELIZA_LOCAL_ONLY.
				return findLocalCandidate(eligible);
			}
			case "cloud-only": {
				// Force cloud: never dispatch to an on-device backend. Returns null
				// (→ dispatch fails closed) when only local handlers are registered.
				return eligible.find((c) => !isLocalProvider(c.provider)) ?? null;
			}
			case "cheapest": {
				const ranked = [...eligible].sort((a, b) => {
					const ca = this.costOf(a.provider) ?? Number.POSITIVE_INFINITY;
					const cb = this.costOf(b.provider) ?? Number.POSITIVE_INFINITY;
					if (ca !== cb) return ca - cb;
					return b.priority - a.priority;
				});
				return ranked[0] ?? null;
			}
			case "fastest": {
				const ranked = [...eligible].sort((a, b) => {
					const la = this.p50(a.provider, args.modelType);
					const lb = this.p50(b.provider, args.modelType);
					// Untracked providers get Infinity → deprioritised until we
					// have samples. First call always falls through to native
					// priority via the tie-break.
					const va = la ?? Number.POSITIVE_INFINITY;
					const vb = lb ?? Number.POSITIVE_INFINITY;
					if (va !== vb) return va - vb;
					return b.priority - a.priority;
				});
				return ranked[0] ?? null;
			}
			case "prefer-local": {
				const local = findLocalCandidate(eligible);
				// Soft capability hint: a device that cannot run this slot's
				// modality demotes the local pick so we don't force an unusable
				// on-device path. When no assessment is present, keep the
				// historical local-first behaviour.
				const tier = args.deviceTier ?? null;
				const localUnviable =
					tier !== null && !modalityViableForSlot(tier, args.slot);
				if (local && !localUnviable) return local;
				const cloud = eligible.find((c) => !isLocalProvider(c.provider));
				if (cloud) return cloud;
				return local ?? eligible[0] ?? null;
			}
			case "round-robin": {
				// Pick the one least-recently-picked. Ties broken by priority.
				const ranked = [...eligible].sort((a, b) => {
					const la = this.lastPicked(a.provider, args.modelType) ?? 0;
					const lb = this.lastPicked(b.provider, args.modelType) ?? 0;
					if (la !== lb) return la - lb;
					return b.priority - a.priority;
				});
				return ranked[0] ?? null;
			}
		}
		return eligible[0] ?? null;
	}

	/** For tests and diagnostics. */
	snapshot(): Record<string, Record<string, number | null>> {
		const out: Record<string, Record<string, number | null>> = {};
		for (const [provider, stats] of this.stats) {
			out[provider] = {};
			for (const [modelType, buf] of stats.latency) {
				const row = out[provider];
				if (row) row[modelType] = buf.p50();
			}
		}
		return out;
	}
}

export const policyEngine = new PolicyEngine();
