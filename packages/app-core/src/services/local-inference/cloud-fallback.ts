/**
 * Soft cloud-fallback wrapper for local-inference TEXT_LARGE / TEXT_SMALL.
 *
 * Why this exists: on mobile (AOSP / iOS) the local llama backend has very
 * different failure modes from a desktop process. The model GGUF may not be
 * staged yet, the FFI dlopen may have failed, the device may be in low-power
 * mode and refuse to prefill, or the user may have explicitly disabled the
 * local engine. We do not want any of those states to surface as a
 * "No handler found for delegate type: TEXT_LARGE" runtime error — when an
 * Anthropic / OpenAI / Eliza Cloud handler is also registered, the runtime
 * should transparently fall through to cloud.
 *
 * Design constraints (per AGENTS.md):
 *  - No silent try/catch. The wrapper distinguishes "ran successfully" from
 *    "ran and decided to fallback" via an EXPLICIT typed return:
 *      { kind: "ok"; text: string }
 *      | { kind: "fallback"; reason: FallbackReason }
 *    Callers branch on `kind`. The wrapper does NOT swallow errors —
 *    any unhandled throw bubbles up to the runtime.
 *  - Local errors are CLASSIFIED. Unrecoverable bugs (programming errors,
 *    out-of-memory, OS kill signals) propagate. Recoverable conditions
 *    (model not staged, abort, downstream provider transient) trigger
 *    fallback.
 *  - Cloud forwarding is registry-driven. We look up the next-highest
 *    priority handler from the runtime's model registry rather than
 *    hardcoding "anthropic" or "openai". That keeps the wrapper neutral
 *    to which cloud is paired.
 */

import type {
  GenerateTextParams,
  IAgentRuntime,
  JsonValue,
  ModelTypeName,
} from "@elizaos/core";

export type FallbackReason =
  /** Local backend reported it can't serve this request at all (no model, FFI dlopen failed, etc). */
  | "local-unavailable"
  /** Local backend was busy, queued past a deadline, or refused (thermal, low-power). */
  | "local-overloaded"
  /** Local backend errored during prefill or decode. */
  | "local-error"
  /** Caller cancelled before local could finish; cloud may still serve. */
  | "local-aborted-pre-completion"
  /** Local handler isn't registered on this runtime build. */
  | "local-not-registered";

export type LocalGenerateOutcome =
  | { kind: "ok"; text: string }
  | { kind: "fallback"; reason: FallbackReason; cause?: Error };

/**
 * Classify a thrown error as a fallback-eligible failure or a hard bug that
 * should propagate. The split is conservative: only well-known recoverable
 * shapes flip to fallback; anything else bubbles up so the operator sees the
 * real failure instead of a silent rotation to cloud.
 */
export function classifyLocalError(err: unknown): {
  fallback: boolean;
  reason: FallbackReason;
} {
  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message.toLowerCase();
    if (name === "AbortError") {
      return { fallback: false, reason: "local-aborted-pre-completion" };
    }
    if (
      msg.includes("no bundled") ||
      msg.includes("not installed in this build") ||
      msg.includes("node-llama-cpp is not installed") ||
      msg.includes("no local model is active") ||
      msg.includes("dlopen") ||
      msg.includes("missing libllama")
    ) {
      return { fallback: true, reason: "local-unavailable" };
    }
    if (
      msg.includes("decode: failed to find a memory slot") ||
      msg.includes("thermal") ||
      msg.includes("low-power")
    ) {
      return { fallback: true, reason: "local-overloaded" };
    }
    if (
      msg.includes("llama_decode") ||
      msg.includes("llama_tokenize") ||
      msg.includes("llama_sampler") ||
      msg.includes("ggml_assert")
    ) {
      return { fallback: true, reason: "local-error" };
    }
  }
  return { fallback: false, reason: "local-error" };
}

/**
 * Locate a cloud TEXT_* handler in the runtime's model registry that is NOT
 * the supplied `localProvider`. The runtime stores handlers per-modelType
 * sorted by priority; we walk the list and skip our own provider so we
 * delegate to cloud instead of recursing into local.
 */
export type RuntimeWithModelLookup = IAgentRuntime & {
  models: Map<
    string,
    Array<{
      provider: string;
      priority: number;
      handler: (
        runtime: IAgentRuntime,
        params: Record<string, JsonValue | object>,
      ) => Promise<JsonValue | object>;
    }>
  >;
};

export interface CloudCandidate {
  provider: string;
  priority: number;
  handler: (
    runtime: IAgentRuntime,
    params: Record<string, JsonValue | object>,
  ) => Promise<JsonValue | object>;
}

export function findCloudCandidate(
  runtime: IAgentRuntime,
  modelType: ModelTypeName | string,
  excludeProvider: string,
): CloudCandidate | null {
  const r = runtime as RuntimeWithModelLookup;
  const entries = r.models?.get(String(modelType));
  if (!entries || entries.length === 0) return null;
  // Sorted highest priority first by the runtime's registration. We want
  // the FIRST non-local provider; that's our cloud candidate.
  for (const entry of entries) {
    if (entry.provider !== excludeProvider) {
      return {
        provider: entry.provider,
        priority: entry.priority,
        handler: entry.handler,
      };
    }
  }
  return null;
}

export interface CloudFallbackOptions {
  /** Provider id of the local handler being wrapped (e.g. "eliza-aosp-llama"). */
  localProvider: string;
  /** Model type this wrapper services (TEXT_LARGE, TEXT_SMALL, etc). */
  modelType: ModelTypeName | string;
  /**
   * The local handler we wrap. Returns `{ kind: "ok" }` on success;
   * `{ kind: "fallback", reason }` to delegate to cloud.
   */
  localGenerate: (
    runtime: IAgentRuntime,
    params: GenerateTextParams,
  ) => Promise<LocalGenerateOutcome>;
  /** Optional logger; defaults to `console`-style no-op so we stay framework-free. */
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * Build a registered-handler-shape function that:
 *  1. Calls `localGenerate`.
 *  2. If `localGenerate` returns `{ kind: "ok" }`, returns that text.
 *  3. If it returns `{ kind: "fallback" }`, looks up the next-best cloud
 *     handler for the same modelType and forwards to it. If no cloud
 *     handler exists, throws a typed error with the fallback reason.
 *
 * The returned function is suitable for `runtime.registerModel`.
 */
export function makeCloudFallbackHandler(
  opts: CloudFallbackOptions,
): (
  runtime: IAgentRuntime,
  params: Record<string, JsonValue | object>,
) => Promise<string> {
  const log = opts.log ?? (() => undefined);
  return async (runtime, params) => {
    const generateParams = params as unknown as GenerateTextParams;
    const local = await opts.localGenerate(runtime, generateParams);
    if (local.kind === "ok") {
      return local.text;
    }
    log(
      `[cloud-fallback] local handler returned fallback (reason=${local.reason})`,
      { modelType: String(opts.modelType), reason: local.reason },
    );
    const candidate = findCloudCandidate(
      runtime,
      opts.modelType,
      opts.localProvider,
    );
    if (!candidate) {
      const err = new Error(
        `[cloud-fallback] Local inference reported ${local.reason} and no cloud handler is registered for ${String(opts.modelType)}. Pair Eliza Cloud or install a provider plugin (anthropic/openai) to enable fallback.`,
      );
      if (local.cause) {
        (err as Error & { cause?: unknown }).cause = local.cause;
      }
      throw err;
    }
    log(
      `[cloud-fallback] forwarding to ${candidate.provider} @ priority ${candidate.priority}`,
      {
        modelType: String(opts.modelType),
        provider: candidate.provider,
        reason: local.reason,
      },
    );
    const result = await candidate.handler(runtime, params);
    if (typeof result !== "string") {
      throw new Error(
        `[cloud-fallback] Cloud handler ${candidate.provider} returned non-string result for ${String(opts.modelType)}.`,
      );
    }
    return result;
  };
}
