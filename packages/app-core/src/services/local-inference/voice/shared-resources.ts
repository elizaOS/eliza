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
}
