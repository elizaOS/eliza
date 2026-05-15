/**
 * Voice-budget allocator — single arbiter of the co-resident memory budget
 * for the whole voice + text bundle (text LM, drafter, ASR, TTS, embedding,
 * VAD, wake-word, turn-detector, emotion classifier, speaker encoder).
 *
 * Today's `ram-budget.ts` is per-tier: it decides whether ONE text bundle
 * fits a host. `voice-budget.ts` is the cross-model layer the brief
 * mandated in `.swarm/VOICE_WAVE_2.md` §H4 and R9 §4 — every model loader
 * calls `reserve()` before it loads weights, releases on unload, and
 * `reserve()` walks the residents under contention by eviction priority
 * (cold → warm → hot) until the requested amount fits.
 *
 * Priorities (from R9 §4.1, mapped to `ResidentModelRole`):
 *
 *   - **hot**  (priority ≥ 40): `text-target`, `tts`, `asr` — never load
 *     on demand, never evicted before pressure-of-last-resort.
 *   - **warm** (priority 25–35): `vad`, `embedding` — may be evicted but
 *     reload is expensive.
 *   - **cold** (priority ≤ 20): `speaker-id` (18), `emotion` (15),
 *     `vision` (20), `drafter` (10) — load-on-demand; first to evict.
 *
 * Eviction policy: walk ascending priority (cheapest first) until enough
 * memory has been reclaimed. The text target evicts only when it is
 * literally the only resident role and pressure persists (matches
 * `SharedResourceRegistry.evictLowestPriorityRole` semantics).
 *
 * The allocator is **memory-only** — it does not load weights. The caller
 * (TTS engine, ASR loader, etc.) holds the typed reservation and runs
 * `release()` on unload.
 *
 * Wire-up plan (handed to follow-up commits, NOT done by I9):
 *   - `dflash-server.ts`     → `reserve(role="text-target")` + `reserve(role="drafter")` at spawn.
 *   - `voice/pipeline.ts`    → `reserve(role="tts", bytes=transientPeakMb*MB)` per synth.
 *   - `voice/wake-word.ts`, `vad.ts`, `eot-classifier.ts` → reserve at session arm.
 *   - I2/I3 add `emotion` + `speaker-id` reservations when those models register.
 *
 * NOTE: the wire-up is intentionally separate from the allocator
 * implementation because the in-flight I-agents (I1/I2/I3/I5) own those
 * loader files and we must not race their edits. The allocator + the
 * `evictionPriority` hooks are in place; the loaders adopt it as they
 * land.
 */
import { classifyDeviceTier, effectiveModelMemoryGb } from "../device-tier";
import { RESIDENT_ROLE_PRIORITY } from "./shared-resources";
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 ** 3;
export function priorityClassForRole(role) {
	const p = RESIDENT_ROLE_PRIORITY[role];
	if (p >= 40) return "hot";
	if (p >= 25) return "warm";
	return "cold";
}
export class BudgetExhaustedError extends Error {
	code = "voice-budget-exhausted";
	details;
	constructor(details) {
		super(
			`[voice-budget] Cannot fit ${(details.requestedBytes / BYTES_PER_MB).toFixed(0)} MB ` +
				`reservation for role "${details.role}" (priority ${details.priority}). ` +
				`Free: ${(details.freeBytes / BYTES_PER_MB).toFixed(0)} MB / ` +
				`total: ${(details.totalBytes / BYTES_PER_MB).toFixed(0)} MB. ` +
				`Evicted: [${details.evictedRoles.join(", ")}]. ` +
				`Next candidate: ${details.evictionCandidate ?? "none (only hot reservations remain)"}.`,
		);
		this.name = "BudgetExhaustedError";
		this.details = details;
	}
}
/**
 * Per-tier total budget table (in bytes). Sized to the §2.3 co-resident
 * roll-up in R9: MAX/GOOD/OKAY/POOR keep the relevant subset of weights +
 * KV + TTS transient peak resident with an OS reserve.
 *
 * - MAX:  ~24 GB free RAM (enough to keep 9b + drafter + omnivoice-Q8 +
 *         ASR + embed + warm/cold path co-resident).
 * - GOOD: ~12 GB (2b/4b co-resident + transient).
 * - OKAY: ~6 GB (0.8b LM only resident; ASR/TTS swap).
 * - POOR: ~3 GB (turn + VAD + wake only, no LM/TTS local).
 *
 * The `maxRamMB` user override (R9 §5.3) can cap this lower. The default
 * picks the tier's natural total but never exceeds the device's effective
 * model memory.
 */
function defaultTierBudgetBytes(probe, tier) {
	const effectiveGb = effectiveModelMemoryGb(probe);
	switch (tier) {
		case "MAX":
			return Math.min(24, effectiveGb) * BYTES_PER_GB;
		case "GOOD":
			return Math.min(12, effectiveGb) * BYTES_PER_GB;
		case "OKAY":
			return Math.min(6, effectiveGb) * BYTES_PER_GB;
		case "POOR":
			return Math.min(3, Math.max(1, effectiveGb)) * BYTES_PER_GB;
	}
}
const _MB = 1; // alias for readability inside the table
const _GB = 1024;
/** R9 §2.3 — measured co-resident bundle for every supported tier slot. */
export const VOICE_ENSEMBLE_BUDGETS = {
	"mobile-0_8b": buildEnsemble({
		tierSlot: "mobile-0_8b",
		lmMb: 0.5 * _GB,
		lmKvMb: 0.044 * _GB,
		drafterMb: 0.31 * _GB,
		ttsMb: 0.08 * _GB, // kokoro-q8 ONNX
		asrMb: 0.4 * _GB, // qwen3-asr-0.6B documented Q4-equiv
		asrMmprojMb: 0.2 * _GB,
		embeddingMb: 0, // pools from LM on the 0.8B tier
		vadMb: 2 * _MB, // silero-vad documented baseline
		wakeWordMb: 4 * _MB,
		turnDetectorMb: 60 * _MB, // turnsense 135M int8 mobile
		emotionMb: 40 * _MB, // wav2small int8 acoustic
		speakerEncoderMb: 10 * _MB, // wespeaker / x-vector int8
		transientTtsBufferMb: 0, // mobile defaults to cloud TTS or kokoro burst
	}),
	"desktop-0_8b": buildEnsemble({
		tierSlot: "desktop-0_8b",
		lmMb: 0.5 * _GB,
		lmKvMb: 0.044 * _GB,
		drafterMb: 0.31 * _GB,
		ttsMb: 0.65 * _GB, // omnivoice base (Q4_K_M = 388.6 MB) + tokenizer (240.8 MB)
		asrMb: 0.4 * _GB,
		asrMmprojMb: 0.2 * _GB,
		embeddingMb: 0,
		vadMb: 2 * _MB,
		wakeWordMb: 4 * _MB,
		turnDetectorMb: 100 * _MB, // livekit/turn-detector v1.2.2-en SmolLM2-135M
		emotionMb: 40 * _MB,
		speakerEncoderMb: 10 * _MB,
		transientTtsBufferMb: 1.17 * _GB, // omnivoice MaskGIT compute peak
	}),
	"desktop-2b": buildEnsemble({
		tierSlot: "desktop-2b",
		lmMb: 1.4 * _GB,
		lmKvMb: 0.075 * _GB,
		drafterMb: 0.5 * _GB,
		ttsMb: 0.65 * _GB,
		asrMb: 0.4 * _GB,
		asrMmprojMb: 0.2 * _GB,
		embeddingMb: 0.4 * _GB, // eliza-1-embedding.gguf 0.6B Q4-ish
		vadMb: 2 * _MB,
		wakeWordMb: 4 * _MB,
		turnDetectorMb: 100 * _MB,
		emotionMb: 40 * _MB,
		speakerEncoderMb: 10 * _MB,
		transientTtsBufferMb: 1.17 * _GB,
	}),
	"desktop-4b": buildEnsemble({
		tierSlot: "desktop-4b",
		lmMb: 2.6 * _GB,
		lmKvMb: 0.3 * _GB,
		drafterMb: 0.7 * _GB,
		ttsMb: 0.65 * _GB,
		asrMb: 0.4 * _GB,
		asrMmprojMb: 0.2 * _GB,
		embeddingMb: 0.4 * _GB,
		vadMb: 2 * _MB,
		wakeWordMb: 4 * _MB,
		turnDetectorMb: 400 * _MB, // livekit/turn-detector v0.4.1-intl Qwen2.5-0.5B
		emotionMb: 40 * _MB,
		speakerEncoderMb: 10 * _MB,
		transientTtsBufferMb: 1.17 * _GB,
	}),
	"workstation-9b": buildEnsemble({
		tierSlot: "workstation-9b",
		lmMb: 5.4 * _GB,
		lmKvMb: 0.56 * _GB,
		drafterMb: 1.4 * _GB,
		ttsMb: 1.28 * _GB, // omnivoice Q8_0 on 9B+ tiers per voiceQuantForTier()
		asrMb: 0.4 * _GB,
		asrMmprojMb: 0.2 * _GB,
		embeddingMb: 0.4 * _GB,
		vadMb: 2 * _MB,
		wakeWordMb: 4 * _MB,
		turnDetectorMb: 400 * _MB,
		emotionMb: 40 * _MB,
		speakerEncoderMb: 10 * _MB,
		transientTtsBufferMb: 1.17 * _GB,
	}),
	"workstation-27b": buildEnsemble({
		tierSlot: "workstation-27b",
		lmMb: 16.8 * _GB,
		lmKvMb: 2.75 * _GB,
		drafterMb: 2.6 * _GB,
		ttsMb: 1.28 * _GB,
		asrMb: 1.1 * _GB, // qwen3-asr-1.7B on the 27B tier
		asrMmprojMb: 0.3 * _GB,
		embeddingMb: 0.4 * _GB,
		vadMb: 2 * _MB,
		wakeWordMb: 4 * _MB,
		turnDetectorMb: 400 * _MB,
		emotionMb: 40 * _MB,
		speakerEncoderMb: 10 * _MB,
		transientTtsBufferMb: 1.17 * _GB,
	}),
};
function buildEnsemble(rows) {
	const steadyStateMb =
		rows.lmMb +
		rows.lmKvMb +
		rows.drafterMb +
		rows.ttsMb +
		rows.asrMb +
		rows.asrMmprojMb +
		rows.embeddingMb +
		rows.vadMb +
		rows.wakeWordMb +
		rows.turnDetectorMb +
		rows.emotionMb +
		rows.speakerEncoderMb;
	return {
		...rows,
		steadyStateMb,
		peakMb: steadyStateMb + rows.transientTtsBufferMb,
	};
}
/**
 * Estimate the full voice ensemble's peak resident MB for a tier slot.
 * `assertVoiceBundleFitsHost` consults this against the device's host RAM.
 */
export function voiceEnsemblePeakMb(slot) {
	return VOICE_ENSEMBLE_BUDGETS[slot].peakMb;
}
/** Sum of weights + KV (steady-state, excludes transient TTS buffer). */
export function voiceEnsembleSteadyStateMb(slot) {
	return VOICE_ENSEMBLE_BUDGETS[slot].steadyStateMb;
}
/**
 * Pick the canonical voice-tier slot for an installed text model + device
 * tier. The LM size anchors the slot (`eliza-1-0_8b` → `0_8b`, `2b` → `2b`,
 * …) and the device tier picks `mobile-` vs `desktop-` vs `workstation-`
 * for the voice surrounding it. Mobile always pulls the `mobile-0_8b` slot
 * because the brief defaults mobile to cloud TTS+ASR; only the 0.8B local
 * LM stays available there.
 */
export function pickVoiceTierSlot(args) {
	if (args.mobile) return "mobile-0_8b";
	const id = args.textModelId.toLowerCase();
	if (id.includes("27b")) return "workstation-27b";
	if (id.includes("9b")) return "workstation-9b";
	if (id.includes("4b")) return "desktop-4b";
	if (id.includes("2b") || id.includes("1_7b")) return "desktop-2b";
	// 0.8B / 0.6B / unknown small fall through to desktop-0_8b on non-mobile.
	if (args.deviceTier === "POOR" || args.deviceTier === "OKAY") {
		return "desktop-0_8b";
	}
	return "desktop-0_8b";
}
/** Default OS reserve subtracted from the host before the bundle check. */
export const DEFAULT_VOICE_BUNDLE_RESERVE_MB = 1536;
/**
 * Decide whether the whole voice ensemble fits a host. Used by the runtime
 * at voice-session-start to refuse local-voice entry rather than start it
 * and watch `MemoryMonitor` evict the loaders mid-session.
 *
 * `assertVoiceBundleFitsHost` (in `active-model.ts`) wraps this with a
 * typed error. This function returns the raw decision so callers that want
 * to degrade silently can do so. R9 §1.4 spec.
 */
export function assessVoiceBundleFits(args) {
	const reserveMb = args.reserveMb ?? DEFAULT_VOICE_BUNDLE_RESERVE_MB;
	const usableMb = Math.max(0, args.hostRamMb - reserveMb);
	const ensemble = VOICE_ENSEMBLE_BUDGETS[args.tierSlot];
	const steadyStateMb = ensemble.steadyStateMb;
	const peakMb = ensemble.peakMb;
	let level;
	if (usableMb >= peakMb) level = "fits";
	else if (usableMb >= steadyStateMb) level = "tight";
	else level = "wontfit";
	return {
		tierSlot: args.tierSlot,
		deviceTier: args.deviceTier,
		steadyStateMb,
		peakMb,
		usableMb,
		fits: level !== "wontfit",
		level,
	};
}
class VoiceBudgetImpl {
	_totalBytes;
	_assessment;
	_reservations = new Map();
	_usedBytes = 0;
	constructor(args) {
		this._totalBytes = args.totalBytes;
		this._assessment = args.assessment;
	}
	freeBytes() {
		return Math.max(0, this._totalBytes - this._usedBytes);
	}
	totalBytes() {
		return this._totalBytes;
	}
	tier() {
		return this._assessment.tier;
	}
	assessment() {
		return this._assessment;
	}
	snapshot() {
		return Array.from(this._reservations.values())
			.filter((r) => !r.released)
			.sort((a, b) => a.priorityRank - b.priorityRank)
			.map(({ id, role, bytes, priority, priorityRank }) => ({
				id,
				role,
				bytes,
				priority,
				priorityRank,
			}));
	}
	async reserve(args) {
		const priority = args.priority ?? priorityClassForRole(args.role);
		const priorityRank = RESIDENT_ROLE_PRIORITY[args.role];
		const requestedBytes = Math.max(0, Math.floor(args.bytes));
		const requestedPriorityRank = priorityRank;
		if (requestedBytes > this._totalBytes) {
			throw new BudgetExhaustedError({
				requestedBytes,
				freeBytes: this.freeBytes(),
				totalBytes: this._totalBytes,
				role: args.role,
				priority,
				evictedRoles: [],
				evictionCandidate: null,
			});
		}
		const evictedRoles = [];
		// Walk evictable reservations in ascending priority (cheapest first)
		// until enough memory fits. We only evict reservations with a STRICTLY
		// LOWER priority rank than the request; equal or higher priority
		// reservations stay put.
		while (this.freeBytes() < requestedBytes) {
			const candidate = this.lowestPriorityEvictableReservation(
				requestedPriorityRank,
			);
			if (!candidate) {
				throw new BudgetExhaustedError({
					requestedBytes,
					freeBytes: this.freeBytes(),
					totalBytes: this._totalBytes,
					role: args.role,
					priority,
					evictedRoles,
					evictionCandidate: null,
				});
			}
			if (args.evictHook) {
				// Let the caller actually unload the weights. The hook returns the
				// bytes it reclaimed; we still drop the accounting entry by the
				// recorded `bytes` field — partial reclamation is treated as
				// success (the loader, not the allocator, owns the side effect).
				await args.evictHook(candidate.role, candidate.id);
			}
			candidate.released = true;
			this._reservations.delete(candidate.id);
			this._usedBytes = Math.max(0, this._usedBytes - candidate.bytes);
			evictedRoles.push(candidate.role);
		}
		const id = `${args.modelId}#${args.role}#${Date.now().toString(36)}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		const entry = {
			id,
			role: args.role,
			bytes: requestedBytes,
			priority,
			priorityRank,
			released: false,
		};
		this._reservations.set(id, entry);
		this._usedBytes += requestedBytes;
		const release = () => {
			if (entry.released) return;
			entry.released = true;
			this._reservations.delete(id);
			this._usedBytes = Math.max(0, this._usedBytes - entry.bytes);
		};
		return {
			id,
			role: entry.role,
			bytes: entry.bytes,
			priority: entry.priority,
			priorityRank: entry.priorityRank,
			release,
		};
	}
	lowestPriorityEvictableReservation(requesterRank) {
		let cheapest = null;
		for (const entry of this._reservations.values()) {
			if (entry.released) continue;
			if (entry.priorityRank >= requesterRank) continue;
			if (!cheapest || entry.priorityRank < cheapest.priorityRank) {
				cheapest = entry;
			}
		}
		return cheapest;
	}
}
/** Public factory. */
export function createVoiceBudget(args) {
	const assessment = args.assessment ?? classifyDeviceTier(args.probe);
	const naturalBytes = defaultTierBudgetBytes(args.probe, assessment.tier);
	let totalBytes = naturalBytes;
	if (typeof args.maxRamMb === "number" && args.maxRamMb > 0) {
		const cap = Math.floor(args.maxRamMb * BYTES_PER_MB);
		totalBytes = Math.min(naturalBytes, cap);
	}
	return new VoiceBudgetImpl({ totalBytes, assessment });
}
/** Test seam — construct a budget with explicit total bytes + assessment. */
export function createVoiceBudgetForTest(args) {
	return new VoiceBudgetImpl({
		totalBytes: args.totalBytes,
		assessment: args.assessment,
	});
}
//# sourceMappingURL=voice-budget.js.map
