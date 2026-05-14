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

import {
	classifyDeviceTier,
	type DeviceTier,
	type DeviceTierAssessment,
	effectiveModelMemoryGb,
} from "../device-tier";
import type { HardwareProbe } from "../types";
import {
	RESIDENT_ROLE_PRIORITY,
	type ResidentModelRole,
} from "./shared-resources";

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 ** 3;

/** Coarse priority class consumed by `reserve()`. Internally we map this
 *  back to the per-role priority number in `RESIDENT_ROLE_PRIORITY`. */
export type AllocationPriority = "hot" | "warm" | "cold";

export function priorityClassForRole(role: ResidentModelRole): AllocationPriority {
	const p = RESIDENT_ROLE_PRIORITY[role];
	if (p >= 40) return "hot";
	if (p >= 25) return "warm";
	return "cold";
}

export interface BudgetReservation {
	readonly id: string;
	readonly role: ResidentModelRole;
	readonly bytes: number;
	readonly priority: AllocationPriority;
	/** Per-role priority number (R9 §4.1 / `RESIDENT_ROLE_PRIORITY`). */
	readonly priorityRank: number;
	/** Idempotent. Multi-release is a no-op (release happens from teardown
	 *  paths that may race). */
	release(): void;
}

/** Diagnostic snapshot row for `VoiceBudget.snapshot()`. */
export interface ReservationSnapshot {
	id: string;
	role: ResidentModelRole;
	bytes: number;
	priority: AllocationPriority;
	priorityRank: number;
}

export class BudgetExhaustedError extends Error {
	readonly code = "voice-budget-exhausted";
	readonly details: {
		requestedBytes: number;
		freeBytes: number;
		totalBytes: number;
		role: ResidentModelRole;
		priority: AllocationPriority;
		evictedRoles: ReadonlyArray<ResidentModelRole>;
		evictionCandidate: ResidentModelRole | null;
	};
	constructor(details: BudgetExhaustedError["details"]) {
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

export interface VoiceBudget {
	/**
	 * Reserve `bytes` for `modelId` with `priority`. Returns a handle the
	 * caller MUST `.release()` to give the memory back. Throws
	 * `BudgetExhaustedError` when the requested amount cannot fit even after
	 * evicting every available lower-priority reservation.
	 *
	 * `evictHook` is optional: when present, the allocator will call it for
	 * each role that needs to be evicted (one at a time, ascending priority)
	 * before recording the new reservation. When omitted, the allocator just
	 * walks its own internal table — the caller is expected to drive the
	 * actual weight unload (the loader/eviction path lives in the model's
	 * own service, not here).
	 */
	reserve(args: {
		modelId: string;
		role: ResidentModelRole;
		bytes: number;
		/** Optional; defaults to `priorityClassForRole(role)`. */
		priority?: AllocationPriority;
		/** Optional eviction callback. When provided, called once per evicted
		 *  role in ascending-priority order before the new reservation is
		 *  recorded. The callback should drop the weights and return the
		 *  bytes actually reclaimed (must be >= the reservation's recorded
		 *  bytes). When omitted, the allocator only drops the internal
		 *  reservation entry (eviction-by-accounting). */
		evictHook?: (role: ResidentModelRole, id: string) => Promise<number>;
	}): Promise<BudgetReservation>;

	/** Best-effort current free budget, in bytes. */
	freeBytes(): number;
	/** Total budget on this device, in bytes. */
	totalBytes(): number;
	/** All current reservations, ordered by priority ascending. */
	snapshot(): ReadonlyArray<ReservationSnapshot>;
	/** The tier this budget was sized to. */
	tier(): DeviceTier;
	/** The original assessment. */
	assessment(): DeviceTierAssessment;
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
function defaultTierBudgetBytes(
	probe: HardwareProbe,
	tier: DeviceTier,
): number {
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

interface InternalReservation {
	id: string;
	role: ResidentModelRole;
	bytes: number;
	priority: AllocationPriority;
	priorityRank: number;
	released: boolean;
}

class VoiceBudgetImpl implements VoiceBudget {
	private readonly _totalBytes: number;
	private readonly _assessment: DeviceTierAssessment;
	private readonly _reservations = new Map<string, InternalReservation>();
	private _usedBytes = 0;

	constructor(args: {
		totalBytes: number;
		assessment: DeviceTierAssessment;
	}) {
		this._totalBytes = args.totalBytes;
		this._assessment = args.assessment;
	}

	freeBytes(): number {
		return Math.max(0, this._totalBytes - this._usedBytes);
	}

	totalBytes(): number {
		return this._totalBytes;
	}

	tier(): DeviceTier {
		return this._assessment.tier;
	}

	assessment(): DeviceTierAssessment {
		return this._assessment;
	}

	snapshot(): ReadonlyArray<ReservationSnapshot> {
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

	async reserve(args: {
		modelId: string;
		role: ResidentModelRole;
		bytes: number;
		priority?: AllocationPriority;
		evictHook?: (role: ResidentModelRole, id: string) => Promise<number>;
	}): Promise<BudgetReservation> {
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

		const evictedRoles: ResidentModelRole[] = [];

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
		const entry: InternalReservation = {
			id,
			role: args.role,
			bytes: requestedBytes,
			priority,
			priorityRank,
			released: false,
		};
		this._reservations.set(id, entry);
		this._usedBytes += requestedBytes;

		const release = (): void => {
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

	private lowestPriorityEvictableReservation(
		requesterRank: number,
	): InternalReservation | null {
		let cheapest: InternalReservation | null = null;
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
export function createVoiceBudget(args: {
	probe: HardwareProbe;
	/** Optional user override for the budget cap, in MB. Default: tier
	 *  natural total. Clamped to the device's effective model memory. */
	maxRamMb?: number;
	/** Optional pre-computed assessment (avoid double classification). */
	assessment?: DeviceTierAssessment;
}): VoiceBudget {
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
export function createVoiceBudgetForTest(args: {
	totalBytes: number;
	assessment: DeviceTierAssessment;
}): VoiceBudget {
	return new VoiceBudgetImpl({
		totalBytes: args.totalBytes,
		assessment: args.assessment,
	});
}
