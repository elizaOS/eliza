/**
 * Optimistic prefill client (C7) — implements `/v1/prefill` against the
 * llama.cpp REST API in three phases:
 *
 *   Phase 1 — `slot/save`:  snapshot the pre-user-message KV state so a
 *             rollback can restore it if speech continues (SPEECH_ACTIVE_REBOUND).
 *
 *   Phase 2 — `POST /completion` with stream=false + cache_prompt=true:
 *             run the model's prefill over `partialText` without sampling any
 *             output tokens.  This warms the KV cache so the subsequent real
 *             generation can skip one full prefill RTT.
 *
 *   Phase 3 — `slot/save` again: snapshot the post-prefill KV state under a
 *             separate name.  The voice state machine passes this handle to the
 *             verifier so generation resumes from the prefilled position.
 *
 * The upstream `/v1/prefill` endpoint does not yet exist — the fork PR that
 * adds it is tracked in `docs/eliza-1-optimistic-rollback.md`.  Until it
 * lands, phases 1–3 are emulated via the existing slot-save REST path.  When
 * the upstream endpoint ships the body of `prefillOptimistic` switches to a
 * single REST call — callers see no signature change.
 *
 *   TODO(upstream-fork-PR-#TBD): replace phases 2+3 with a single
 *   `POST /v1/prefill { slotId, partialText, eotProb }` that:
 *     1. Runs the model's prefill over `partialText` against `slotId`.
 *     2. Saves a checkpoint of the resulting KV state.
 *     3. Returns `{ handle, eotProb }`.
 */

import type {
  CheckpointHandle,
  CheckpointManagerLike,
} from "./checkpoint-manager";
import type { ContextPartial } from "./eager-context-builder";

// ---------------------------------------------------------------------------
// Public types — match the task spec so existing callers are unaffected
// ---------------------------------------------------------------------------

/**
 * Input contract for the optimistic prefill call.  `partialText` is the
 * current partial transcript; `eotProb` is the caller's estimate that the
 * user has stopped speaking (from VAD hangover progress or the EOT classifier).
 */
export interface PrefillOptimisticArgs {
  /** Base URL of the llama-server (`http://host:port`). */
  baseUrl: string;
  /** Slot id pinning this conversation. */
  slotId: string;
  /** Partial transcript to prefill against.  Non-empty. */
  partialText: string;
  /**
   * Probability the partial is end-of-turn (0..1).  Today recorded as
   * telemetry only; once `/v1/prefill` lands the server uses it to decide
   * whether to also kick the drafter inline.
   */
  eotProb: number;
  /**
   * Deterministic context from `EagerContextBuilder` (C3).  Used to build the
   * system prompt passed to the prefill `/completion` call so the KV cache
   * covers both the system prompt and the partial transcript.  Optional — when
   * absent, only the partial transcript is prefilled.
   */
  context?: ContextPartial;
}

export interface PrefillOptimisticResult {
  /**
   * Handle to the POST-prefill KV snapshot.  Pass to
   * `CheckpointManager.restoreCheckpoint` on SPEECH_END so the verifier
   * resumes from the prefilled position.
   */
  checkpointHandle: CheckpointHandle;
  /**
   * Approximate token count of the prefilled text.  Derived from a rough
   * whitespace tokenizer since the REST stub doesn't return a token count;
   * once the upstream endpoint lands, the server returns the real count.
   */
  tokenCount: number;
  /**
   * Wall-clock milliseconds the prefill round-trip took (phases 1–3).
   */
  prefillMs: number;
  /**
   * Backend label.  `slot-save-stub` = pre-upstream emulation path;
   * `prefill-v1` = native `/v1/prefill` endpoint.
   */
  backend: "slot-save-stub" | "prefill-v1";
  /**
   * End-of-turn probability echoed back from the server.  Today equals the
   * caller's `eotProb` (the stub has nothing to refine it with); once the
   * upstream endpoint lands, the server returns its own model estimate.
   */
  eotProb: number;
}

export interface PrefillOptimisticOptions {
  checkpointManager: CheckpointManagerLike;
  /**
   * Name to use for the PRE-prefill snapshot (C1 — used by the rollback path
   * on SPEECH_ACTIVE_REBOUND).  Defaults to `pre-prefill`.
   */
  preCheckpointName?: string;
  /**
   * Name to use for the POST-prefill snapshot (the one the verifier starts
   * from on SPEECH_END).  Defaults to `post-prefill`.
   */
  postCheckpointName?: string;
  /**
   * Optional fetch implementation for tests.  Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Request timeout for the `/completion` prefill call (ms).  Default 5 000 ms.
   * The call is a no-sample prefill-only pass, so it should complete in
   * O(transcript_tokens / throughput) — typically well under 1 s for short
   * partials.
   */
  prefillTimeoutMs?: number;
}

const DEFAULT_PRE_CHECKPOINT_NAME = "pre-prefill";
const DEFAULT_POST_CHECKPOINT_NAME = "post-prefill";
const DEFAULT_PREFILL_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Run the three-phase optimistic prefill and return a checkpoint handle for
 * the post-prefill KV state.
 *
 * Voice state machine wiring:
 *   - Call on `PAUSE_TENTATIVE` entry with `eotProb` from the EOT classifier.
 *   - On `SPEECH_ACTIVE_REBOUND` (within rollback window): restore to the
 *     PRE-prefill checkpoint (C1 saved in phase 1) via the checkpoint manager.
 *     The post-prefill handle returned here is no longer needed.
 *   - On `SPEECH_END`: pass `result.checkpointHandle` to the verifier so it
 *     can resume generation from the prefilled KV state, saving one full
 *     prefill RTT.
 */
export async function prefillOptimistic(
  args: PrefillOptimisticArgs,
  opts: PrefillOptimisticOptions,
): Promise<PrefillOptimisticResult> {
  assertPartialText(args.partialText);
  assertEotProb(args.eotProb);
  assertBaseUrl(args.baseUrl);

  const startMs = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const preName = opts.preCheckpointName ?? DEFAULT_PRE_CHECKPOINT_NAME;
  const postName = opts.postCheckpointName ?? DEFAULT_POST_CHECKPOINT_NAME;
  const timeoutMs = opts.prefillTimeoutMs ?? DEFAULT_PREFILL_TIMEOUT_MS;

  // ------------------------------------------------------------------
  // Phase 1: snapshot pre-user-message KV state (rollback target for
  //          SPEECH_ACTIVE_REBOUND).
  // ------------------------------------------------------------------
  await opts.checkpointManager.saveCheckpoint(args.slotId, preName);

  // ------------------------------------------------------------------
  // Phase 2: POST to /completion with the partial text to warm the KV
  //          cache.  We request max_tokens=0 / stream=false so the server
  //          only runs the prefill pass without sampling any tokens.
  //
  //          TODO(upstream-fork-PR-#TBD): replace this with a single
  //          POST /v1/prefill once the upstream endpoint lands.
  // ------------------------------------------------------------------
  await runPrefillCompletion({
    baseUrl: args.baseUrl,
    partialText: args.partialText,
    context: args.context,
    timeoutMs,
    fetchImpl,
  });

  // ------------------------------------------------------------------
  // Phase 3: snapshot post-prefill KV state (the handle the verifier
  //          resumes from on SPEECH_END).
  // ------------------------------------------------------------------
  const postHandle = await opts.checkpointManager.saveCheckpoint(
    args.slotId,
    postName,
  );

  const prefillMs = Date.now() - startMs;
  const tokenCount = estimateTokenCount(args.partialText);

  return {
    checkpointHandle: postHandle,
    tokenCount,
    prefillMs,
    backend: "slot-save-stub",
    eotProb: args.eotProb,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 helper — no-sample /completion call
// ---------------------------------------------------------------------------

interface RunPrefillCompletionOpts {
  baseUrl: string;
  partialText: string;
  context?: ContextPartial;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

/**
 * POST to `/completion` with `max_tokens: 0` to prefill the KV cache without
 * decoding any output tokens.  The system prompt is prepended from the
 * deterministic context half (C3) when available.
 *
 * On HTTP error or timeout we swallow and log a warning — a prefill failure
 * means the verifier will run a regular (non-prefilled) generation, not a
 * crash.  The checkpoint state is still valid (phase 1 snapshot is intact).
 */
async function runPrefillCompletion(
  opts: RunPrefillCompletionOpts,
): Promise<void> {
  const { baseUrl, partialText, context, timeoutMs, fetchImpl } = opts;

  // Build the prompt: deterministic system blocks (if any) + partial transcript.
  const systemText = context?.systemBlocks.filter(Boolean).join("\n\n") ?? "";
  const historyLines = (context?.historyBlocks ?? [])
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
    .join("\n");

  const promptParts: string[] = [];
  if (systemText) promptParts.push(systemText);
  if (historyLines) promptParts.push(historyLines);
  promptParts.push(`User: ${partialText}`);
  const prompt = promptParts.join("\n\n");

  const url = `${baseUrl.replace(/\/$/, "")}/completion`;
  const body = {
    prompt,
    // Zero tokens — prefill only, no decode.
    n_predict: 0,
    // Prefill into the cached slot.
    cache_prompt: true,
    // No sampling needed.
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // Non-200 — prefill attempt failed, but we continue (phase 3 still runs).
      // In the real `/v1/prefill` path the server would surface a clear error;
      // for the stub we tolerate it.
      console.warn(
        `[prefill-client] /completion returned HTTP ${resp.status} — continuing without prefill warm`,
      );
    }
  } catch (err) {
    // Timeout or network failure — swallow.
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "timeout"
        : String(err);
    console.warn(
      `[prefill-client] /completion prefill failed (${reason}) — continuing without prefill warm`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rough token-count estimator — whitespace word count.  Replaced by the
 * server-reported count once the upstream `/v1/prefill` endpoint lands.
 */
function estimateTokenCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function assertPartialText(s: string): void {
  if (typeof s !== "string" || s.trim().length === 0) {
    throw new TypeError(
      `[prefill-client] partialText must be a non-empty string (got ${JSON.stringify(s)})`,
    );
  }
}

function assertEotProb(p: number): void {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new TypeError(
      `[prefill-client] eotProb must be a finite number in [0, 1] (got ${p})`,
    );
  }
}

function assertBaseUrl(url: string): void {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new TypeError(
      `[prefill-client] baseUrl must be a non-empty string (got ${JSON.stringify(url)})`,
    );
  }
}
