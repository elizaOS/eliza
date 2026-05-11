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

/** Minimal structural logger — keeps this module free of upstream deps. */
interface Logger {
  debug?(message: string): void;
  warn?(message: string): void;
  info?(message: string): void;
}

/**
 * The model roles that can be resident at once on the local-inference
 * path. The `MemoryMonitor` evicts them in *ascending priority* under RAM
 * pressure (lowest first): the DFlash drafter is cheapest to drop, the
 * text target is the last thing to go. Voice TTS/ASR weights are evicted
 * via `MmapRegionHandle.evictPages()`; the embedding model by unloading
 * it; the drafter by restarting llama-server without `-md` (a last resort
 * — it's co-resident in that process, so "evict" is heavy).
 */
export type ResidentModelRole =
  | "drafter"
  | "vision"
  | "embedding"
  | "vad"
  | "asr"
  | "tts"
  | "text-target";

/**
 * Eviction priority by role — lower evicts first. Matches the brief's
 * `drafter < vision/mmproj < ASR < TTS < text-target`, with `embedding`
 * (cheap — just `unload()`) just above vision and `vad` near ASR.
 */
export const RESIDENT_ROLE_PRIORITY: Readonly<
  Record<ResidentModelRole, number>
> = {
  drafter: 10,
  vision: 20,
  embedding: 25,
  vad: 35,
  asr: 40,
  tts: 50,
  "text-target": 100,
};

/**
 * An evictable resident model role. The registry walks these in ascending
 * `evictionPriority` under memory pressure and calls `evict()` until enough
 * RAM has been reclaimed. `evict()` MUST be idempotent (a no-op when already
 * evicted) and the role MUST re-load lazily on next use — the monitor only
 * frees memory, it never re-loads.
 */
export interface EvictableModelRole extends RefCountedResource {
  readonly role: ResidentModelRole;
  /** Lower evicts first. Defaults to `RESIDENT_ROLE_PRIORITY[role]`. */
  readonly evictionPriority: number;
  /** True while the underlying weights/pages are still resident. */
  isResident(): boolean;
  /** Drop the resident weights/pages. Idempotent; re-loads lazily on demand. */
  evict(): Promise<void>;
  /** Best-effort estimate of RAM (MB) reclaimed by `evict()`. 0 when unknown. */
  estimatedResidentMb(): number;
}

function isEvictableModelRole(
  value: RefCountedResource,
): value is EvictableModelRole {
  const candidate = value as Partial<EvictableModelRole>;
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
export function createEvictableModelRole(args: {
  id?: string;
  role: ResidentModelRole;
  evictionPriority?: number;
  estimatedMb?: number;
  isResident: () => boolean;
  evict: () => Promise<void>;
  release?: () => Promise<void>;
}): EvictableModelRole {
  const id = args.id ?? `model-role:${args.role}`;
  const priority = args.evictionPriority ?? RESIDENT_ROLE_PRIORITY[args.role];
  const estimatedMb = args.estimatedMb ?? 0;
  return {
    id,
    role: args.role,
    evictionPriority: priority,
    isResident: args.isResident,
    estimatedResidentMb: () => (args.isResident() ? estimatedMb : 0),
    async evict(): Promise<void> {
      if (!args.isResident()) return;
      await args.evict();
    },
    async release(): Promise<void> {
      await args.release?.();
    },
  };
}

/**
 * Anything ref-counted by the registry implements this. The caller of
 * `release()` MUST guarantee that no further reads happen on the
 * underlying resource — for mmap regions that means no kernel call has
 * a pointer into the freed range.
 */
export interface RefCountedResource {
  readonly id: string;
  /** Released for real when the last ref drops. Idempotent. */
  release(): Promise<void>;
}

/**
 * mmap region handle. The fused omnivoice/llama.cpp build owns the real
 * mmap call (it happens inside the FFI) — this interface is the JS-side
 * proxy for it, so the lifecycle code can request page eviction without
 * binding to a specific backend.
 */
export interface MmapRegionHandle extends RefCountedResource {
  /** Absolute path of the file backing the mmap region. */
  readonly path: string;
  /** Byte size of the mapped region. */
  readonly sizeBytes: number;
  /**
   * Release memory pressure for this region. Backends may implement this
   * as a page hint or as a full voice-runtime unload. Common mappings:
   *   - POSIX (Linux/Android/macOS-bg): `madvise(addr, len, MADV_DONTNEED)`
   *   - macOS (foreground / iOS):        `madvise(addr, len, MADV_FREE_REUSABLE)`
   *   - Windows:                         `VirtualUnlock` + `OfferVirtualMemory`
   *
   * The lifecycle test mocks this to assert the call happened.
   */
  evictPages(): Promise<void>;
}

/** Minimal tokenizer surface text + voice both consume. */
export interface SharedTokenizer extends RefCountedResource {
  readonly vocabSize: number;
}

/**
 * Kernel set descriptor. The actual kernels are inside the fused
 * llama.cpp build; this is the metadata the runtime reads at startup
 * (AGENTS.md §3 #5: "the runtime MUST log the kernel set on startup").
 */
export interface KernelSet extends RefCountedResource {
  readonly kernels: ReadonlyArray<string>;
}

/** Scheduler graph slot. One per active engine, refcounted by surface. */
export interface SchedulerSlot extends RefCountedResource {
  /** Surface (text/voice) currently holding a ref. */
  surfaces(): ReadonlyArray<"text" | "voice">;
}

/** DFlash drafter is shared between text-only and voice modes (AGENTS.md §4). */
export interface DflashDrafterHandle extends RefCountedResource {
  readonly drafterModelId: string;
  /**
   * Absolute path of the drafter GGUF the running llama-server was launched
   * with (`-md`). Co-resident with the target for the lifetime of the
   * server — `release()` here just drops the refcount; the actual unmap
   * happens when the server stops.
   */
  readonly drafterModelPath: string;
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
export function createDflashDrafterHandle(args: {
  drafterModelId: string;
  drafterModelPath: string;
}): DflashDrafterHandle {
  return {
    id: `dflash-drafter:${args.drafterModelPath}`,
    drafterModelId: args.drafterModelId,
    drafterModelPath: args.drafterModelPath,
    async release(): Promise<void> {
      // The drafter's mmap lifetime is owned by the llama-server process;
      // dropping the last ref here does not unmap it. This is intentional:
      // the drafter is "always wired" (AGENTS.md §4) and re-acquired the
      // moment voice arms again, so churn is wasteful.
    },
  };
}

interface RegistryEntry<T extends RefCountedResource> {
  readonly resource: T;
  refCount: number;
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
  private readonly entries = new Map<
    string,
    RegistryEntry<RefCountedResource>
  >();
  private readonly log?: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = opts.logger;
  }

  /**
   * Register a resource if absent, increment refcount otherwise. Returns
   * the canonical instance — callers MUST use the returned value, not the
   * one passed in, so a second registration with the same id resolves to
   * the original (deduplication by id).
   */
  acquire<T extends RefCountedResource>(resource: T): T {
    const existing = this.entries.get(resource.id);
    if (existing) {
      existing.refCount++;
      return existing.resource as T;
    }
    this.entries.set(resource.id, { resource, refCount: 1 });
    return resource;
  }

  /**
   * Decrement refcount; release the resource when it hits zero. Throws
   * on unknown id — silent no-ops would hide leaks.
   */
  async release(id: string): Promise<void> {
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
  refCount(id: string): number {
    return this.entries.get(id)?.refCount ?? 0;
  }

  /** Diagnostic: snapshot of currently-tracked resource ids. */
  ids(): ReadonlyArray<string> {
    return Array.from(this.entries.keys());
  }

  /** Total tracked resources. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Currently-resident evictable model roles, ascending by eviction
   * priority (cheapest-to-evict first). Used by `MemoryMonitor` to walk
   * roles under RAM pressure. Non-resident roles are filtered out — there's
   * nothing to reclaim.
   */
  evictableRoles(): ReadonlyArray<EvictableModelRole> {
    const out: EvictableModelRole[] = [];
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
  async evictLowestPriorityRole(): Promise<{
    id: string;
    role: ResidentModelRole;
    estimatedMb: number;
  } | null> {
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
