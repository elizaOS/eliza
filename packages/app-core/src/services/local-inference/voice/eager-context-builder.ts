/**
 * Eager provider context split (C3).
 *
 * Splits provider context assembly into two parts so KV prefill can begin
 * on speech-START — before ASR has produced a transcript:
 *
 *   1. **Deterministic part** — doesn't depend on the user's message text:
 *        system prompt, persona, enabled skills list, conversation history
 *        up to the last turn, tool definitions.
 *      Built on `speech-start` (fire-and-forget via `prebuildDeterministic`).
 *
 *   2. **Message-dependent part** — depends on the actual transcript:
 *        the user's message itself, any message-conditional context injected
 *        by callers (e.g. relevant calendar/contacts snippets).
 *      Built on `speech-end` via `complete(userMessage)`.
 *
 * The codebase routes context through elizaOS's provider pipeline rather than
 * a single `buildContext` call. `EagerContextBuilder` adapts to that model by
 * accepting two async factory functions: one for the deterministic part
 * (returns a `ContextPartial`) and one for the message-dependent part
 * (receives the user message, returns a `ContextPartial`). `mergeContext`
 * combines them in a consistent order so downstream consumers always see
 * `[deterministic parts] + [message-dependent parts]`.
 *
 * Staleness: the deterministic context is considered stale after 30 seconds
 * (conversation history may have changed if the agent received a message from
 * another surface). `complete()` rebuilds when stale.
 *
 * Thread-safety: all methods are async; do NOT call them concurrently from
 * multiple async contexts — the class is designed for single-threaded use by
 * the voice event loop.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A fragment of the final prompt context. Fields are intentionally generic
 * so the same type works regardless of whether the runtime uses raw strings,
 * token arrays, or structured message lists.
 *
 * In practice callers fill `systemBlocks` with things like the system prompt,
 * enabled skills, persona, tool definitions, and `historyBlocks` with the
 * conversation history. `mergeContext` joins them in that order.
 */
export interface ContextPartial {
  /**
   * Ordered list of system / pre-amble text blocks. Each element is a
   * distinct structural unit (e.g. persona block, skills block, tool-defs
   * block). They are joined in order during `mergeContext`.
   */
  systemBlocks: string[];
  /**
   * Conversation history turns up to (but NOT including) the new user
   * message. Stored as alternating `{role, content}` entries for
   * compatibility with the elizaOS message format.
   */
  historyBlocks: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Free-form metadata for diagnostics / telemetry. Not included in the
   * merged prompt text.
   */
  meta?: Record<string, unknown>;
}

/**
 * Complete merged context — the full prompt assembly ready for the LLM
 * inference call. Produced by `mergeContext` from the two halves.
 */
export interface FullContext {
  /**
   * The fully assembled system string (deterministic blocks joined by
   * double-newline, message-dependent blocks appended after).
   */
  systemText: string;
  /**
   * Full conversation history including the new user message at the end.
   */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** ISO timestamp of when the deterministic part was built. */
  deterministicBuiltAt: string;
  /** ISO timestamp of when `complete()` was called. */
  completedAt: string;
  /** True when the deterministic context was rebuilt inside `complete()` due to staleness. */
  deterministicWasStale: boolean;
}

/**
 * Factory function that builds the deterministic context part. Called with no
 * arguments (it must capture its own runtime reference if it needs one).
 */
export type BuildDeterministicFn = () => Promise<ContextPartial>;

/**
 * Factory function that builds the message-dependent context part. Called with
 * the actual user message text.
 */
export type BuildMessageDependentFn = (
  userMessage: string,
) => Promise<ContextPartial>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_STALE_MS = 30_000;

export interface EagerContextBuilderOptions {
  buildDeterministic: BuildDeterministicFn;
  buildMessageDependent: BuildMessageDependentFn;
  /**
   * How many milliseconds before the cached deterministic context is
   * considered stale and must be rebuilt. Default 30 000 ms.
   */
  staleCutoffMs?: number;
  /**
   * Optional clock injection for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Manages eager splitting of provider context into deterministic + message-
 * dependent halves. Wire `prebuildDeterministic` to the `speech-start` event
 * and `complete` to the `speech-end` path (after ASR produces the final
 * transcript).
 */
export class EagerContextBuilder {
  private deterministic: ContextPartial | null = null;
  private builtAt: number = 0;
  private readonly staleCutoffMs: number;
  private readonly buildDeterministicFn: BuildDeterministicFn;
  private readonly buildMessageDependentFn: BuildMessageDependentFn;
  private readonly nowFn: () => number;

  /** In-flight prebuild promise — prevents concurrent duplicate prebuilds. */
  private prebuildInFlight: Promise<void> | null = null;

  constructor(opts: EagerContextBuilderOptions) {
    this.buildDeterministicFn = opts.buildDeterministic;
    this.buildMessageDependentFn = opts.buildMessageDependent;
    this.staleCutoffMs = opts.staleCutoffMs ?? DEFAULT_STALE_MS;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /**
   * Fire on `speech-start` (fire-and-forget). Builds and caches the
   * deterministic context half so it is ready when `complete` is called.
   *
   * Concurrent calls are collapsed into a single in-flight build — safe to
   * call multiple times without double-spending GPU/compute resources.
   */
  prebuildDeterministic(): void {
    if (this.prebuildInFlight) return;
    this.prebuildInFlight = this.runPrebuild().finally(() => {
      this.prebuildInFlight = null;
    });
  }

  /**
   * Call on `speech-end` with the actual final transcript. Returns the fully
   * merged context.
   *
   * If the cached deterministic context is absent or stale it is rebuilt
   * inline (blocking). The returned `deterministicWasStale` flag lets callers
   * emit latency telemetry when the eager pre-build didn't complete in time.
   */
  async complete(userMessage: string): Promise<FullContext> {
    let deterministicWasStale = false;
    // If a prebuild is in-flight, wait for it first (avoids duplicate work).
    if (this.prebuildInFlight) {
      await this.prebuildInFlight;
    }
    let det = this.deterministic;
    if (det === null || this.isStale()) {
      deterministicWasStale = det !== null; // null means never built; stale = was built but expired
      await this.runPrebuild();
      det = this.deterministic!;
    }
    const msgDep = await this.buildMessageDependentFn(userMessage);
    return mergeContext(det, msgDep, {
      deterministicBuiltAt: new Date(this.builtAt).toISOString(),
      completedAt: new Date(this.nowFn()).toISOString(),
      deterministicWasStale,
    });
  }

  /**
   * Returns true if the cached deterministic context is older than
   * `staleCutoffMs`.
   */
  isStale(): boolean {
    if (this.deterministic === null) return true;
    return this.nowFn() - this.builtAt > this.staleCutoffMs;
  }

  /**
   * Discard the cached deterministic context. Useful when the conversation
   * is reset or the runtime is re-initialised. Thread-safe — can be called
   * from any context.
   */
  invalidate(): void {
    this.deterministic = null;
    this.builtAt = 0;
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async runPrebuild(): Promise<void> {
    const result = await this.buildDeterministicFn();
    this.deterministic = result;
    this.builtAt = this.nowFn();
  }
}

// ---------------------------------------------------------------------------
// mergeContext
// ---------------------------------------------------------------------------

/**
 * Merge deterministic and message-dependent context halves into a
 * `FullContext`. The merged output places deterministic system blocks first,
 * then message-dependent system blocks, and appends the user message as the
 * last history turn.
 *
 * @internal Exported for tests.
 */
export function mergeContext(
  det: ContextPartial,
  msgDep: ContextPartial,
  timestamps: {
    deterministicBuiltAt: string;
    completedAt: string;
    deterministicWasStale: boolean;
  },
): FullContext {
  const systemBlocks = [...det.systemBlocks, ...msgDep.systemBlocks];
  const systemText = systemBlocks.filter(Boolean).join("\n\n");

  // History: deterministic half contains history up to last turn; message-
  // dependent half contains the new user message (and any injected turns).
  const history: FullContext["history"] = [
    ...det.historyBlocks,
    ...msgDep.historyBlocks,
  ];

  return {
    systemText,
    history,
    deterministicBuiltAt: timestamps.deterministicBuiltAt,
    completedAt: timestamps.completedAt,
    deterministicWasStale: timestamps.deterministicWasStale,
  };
}
