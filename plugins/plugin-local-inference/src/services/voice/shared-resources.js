/**
 * Cross-cut resource sharing between the text + voice surfaces of a
 * single Eliza-1 bundle.
 *
 * Per `packages/inference/AGENTS.md` §4 ("shared KV cache scheduling,
 * not shared KV memory" + "one process, one llama.cpp build, one GGML
 * pin"), text and voice MUST share:
 *   - the tokenizer (Eliza-1/OmniVoice share a vocabulary in this lineage),
 *   - the mmap regions for weights (deduplicated by absolute path),
 *   - the kernel set (same shipped llama.cpp library after fusion),
 *   - the scheduler queue (one queue, prioritised),
 *   - the DFlash drafter (always wired, see AGENTS.md §3 #4).
 *
 * What they do NOT share:
 *   - KV cache memory (different layer counts, different head configs,
 *     different quantizations — separate caches, shared scheduler).
 *
 * This module owns reference counts on each shared resource and is the
 * single arbiter of when a voice-only region can be released. It does
 * NOT do any I/O itself — the actual mmap, madvise, or full model-unload
 * behavior lives behind the `MmapRegionHandle` interface so platform
 * bindings can choose the right memory policy.
 */
/**
 * Eviction priority by role — lower evicts first. Matches the brief's
 * `drafter < emotion < speaker-id < vision/mmproj < embedding < vad < ASR <
 * TTS < text-target`. The cold-3 set (`emotion`, `speaker-id`) is cheap to
 * load on demand, so evicting them is the first reclamation step under
 * sustained pressure. See `.swarm/research/R9-memory.md` §4.1.
 */
export const RESIDENT_ROLE_PRIORITY = {
	drafter: 10,
	emotion: 15,
	"speaker-id": 18,
	vision: 20,
	embedding: 25,
	vad: 35,
	asr: 40,
	tts: 50,
	"text-target": 100,
};
function isEvictableModelRole(value) {
	const candidate = value;
	return (
		typeof candidate.role === "string" &&
		typeof candidate.evictionPriority === "number" &&
		typeof candidate.isResident === "function" &&
		typeof candidate.evict === "function" &&
		typeof candidate.estimatedResidentMb === "function"
	);
}
/**
 * Build an `EvictableModelRole` from a role + an `evict` callback. `release()`
 * defaults to a no-op (the registry's refcount, not `release`, gates eviction
 * for these); pass one if the role owns disposable state. `estimatedMb` lets
 * the monitor know roughly how much it will reclaim — pass 0 when unknown.
 */
export function createEvictableModelRole(args) {
	const id = args.id ?? `model-role:${args.role}`;
	const priority = args.evictionPriority ?? RESIDENT_ROLE_PRIORITY[args.role];
	const estimatedMb = args.estimatedMb ?? 0;
	return {
		id,
		role: args.role,
		evictionPriority: priority,
		isResident: args.isResident,
		estimatedResidentMb: () => (args.isResident() ? estimatedMb : 0),
		async evict() {
			if (!args.isResident()) return;
			await args.evict();
		},
		async release() {
			await args.release?.();
		},
	};
}
/**
 * Build a real `DflashDrafterHandle` backed by the running llama-server's
 * `-md` drafter. The drafter is mmapped by the fork at server start and stays
 * resident until the server stops, so `release()` is a no-op from this
 * handle's perspective — the registry refcount is what gates whether voice
 * mode may evict the *target's* page set, not the drafter. Returns null when
 * no llama-server is running with a configured drafter (the node-llama-cpp
 * backend has no drafter — text-only, no speculative decoding).
 */
export function createDflashDrafterHandle(args) {
	return {
		id: `dflash-drafter:${args.drafterModelPath}`,
		drafterModelId: args.drafterModelId,
		drafterModelPath: args.drafterModelPath,
		async release() {
			// The drafter's mmap lifetime is owned by the llama-server process;
			// dropping the last ref here does not unmap it. This is intentional:
			// the drafter is "always wired" (AGENTS.md §4) and re-acquired the
			// moment voice arms again, so churn is wasteful.
		},
	};
}
/**
 * Owns the shared resources for one engine. Voice + text both `acquire`
 * and `release` against the same registry; the registry only releases
 * the underlying resource when refcount hits zero.
 *
 * Thread-safety: all methods run on the single Node event loop; no
 * locks needed. Promises returned from `release()` MUST be awaited so
 * the lifecycle state machine can observe completion.
 */
export class SharedResourceRegistry {
	entries = new Map();
	log;
	constructor(opts = {}) {
		this.log = opts.logger;
	}
	/**
	 * Register a resource if absent, increment refcount otherwise. Returns
	 * the canonical instance — callers MUST use the returned value, not the
	 * one passed in, so a second registration with the same id resolves to
	 * the original (deduplication by id).
	 */
	acquire(resource) {
		const existing = this.entries.get(resource.id);
		if (existing) {
			existing.refCount++;
			return existing.resource;
		}
		this.entries.set(resource.id, { resource, refCount: 1 });
		return resource;
	}
	/**
	 * Decrement refcount; release the resource when it hits zero. Throws
	 * on unknown id — silent no-ops would hide leaks.
	 */
	async release(id) {
		const entry = this.entries.get(id);
		if (!entry) {
			throw new Error(
				`[shared-resources] release(${id}): unknown resource — possible double release or registry desync`,
			);
		}
		entry.refCount--;
		if (entry.refCount > 0) return;
		this.entries.delete(id);
		await entry.resource.release();
		this.log?.debug?.(`[SharedResourceRegistry] released ${id}`);
	}
	/** Diagnostic: current refcount, or 0 when not present. */
	refCount(id) {
		return this.entries.get(id)?.refCount ?? 0;
	}
	/** Diagnostic: snapshot of currently-tracked resource ids. */
	ids() {
		return Array.from(this.entries.keys());
	}
	/** Total tracked resources. */
	size() {
		return this.entries.size;
	}
	/**
	 * Currently-resident evictable model roles, ascending by eviction
	 * priority (cheapest-to-evict first). Used by `MemoryMonitor` to walk
	 * roles under RAM pressure. Non-resident roles are filtered out — there's
	 * nothing to reclaim.
	 */
	evictableRoles() {
		const out = [];
		for (const entry of this.entries.values()) {
			if (isEvictableModelRole(entry.resource) && entry.resource.isResident()) {
				out.push(entry.resource);
			}
		}
		return out.sort((a, b) => a.evictionPriority - b.evictionPriority);
	}
	/**
	 * Evict the lowest-priority resident role and return its `id`, or `null`
	 * when nothing is evictable. Observable: emits an `info` log line so the
	 * eviction is visible in the dev console. The role re-loads lazily on
	 * next use — this only frees memory.
	 */
	async evictLowestPriorityRole() {
		const [target] = this.evictableRoles();
		if (!target) return null;
		const estimatedMb = target.estimatedResidentMb();
		await target.evict();
		this.log?.info?.(
			`[SharedResourceRegistry] evicted role ${target.role} (${target.id}); reclaimed ~${estimatedMb} MB`,
		);
		return { id: target.id, role: target.role, estimatedMb };
	}
}
//# sourceMappingURL=shared-resources.js.map
