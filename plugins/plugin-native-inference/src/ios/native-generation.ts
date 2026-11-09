/** Preserves complete iOS native requests and rejects incomplete host output before delivery. The native host owns remaining-context exhaustion; an omitted caller boundary never becomes a reply-token clamp. */
import { ElizaError } from "@elizaos/core";
import { createNativeModelRequestGuard } from "../../../plugin-native-inference/src/shared/native-model-request";

interface IosNativeTextRequest {
  context_id: number;
  prompt: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  top_k: number;
  stop: string[];
}

export async function dispatchIosNativeGeneration(args: {
  provider: string;
  model: string;
  contextWindowTokens: number;
  requestedMaxTokens?: number;
  request: Omit<IosNativeTextRequest, "max_tokens">;
  invoke: (
    request: IosNativeTextRequest,
    timeoutMs: number,
  ) => Promise<unknown>;
  /** Asks the native host to stop decoding this context. */
  cancel?: () => Promise<unknown>;
  signal?: AbortSignal;
}): Promise<string> {
  if (
    args.requestedMaxTokens !== undefined &&
    (!Number.isSafeInteger(args.requestedMaxTokens) ||
      args.requestedMaxTokens < 1)
  ) {
    throw new ElizaError(
      "iOS output boundary must be a positive safe integer",
      { code: "MODEL_OUTPUT_BOUNDARY_INVALID" },
    );
  }
  const maxTokens = args.requestedMaxTokens ?? args.contextWindowTokens;
  const request = { ...args.request, max_tokens: maxTokens };
  const guard = createNativeModelRequestGuard({
    provider: args.provider,
    model: args.model,
    contextWindowTokens: args.contextWindowTokens,
    // With no explicit output request, reserve only room to begin decoding.
    // The host can use every remaining context token and reports exhaustion.
    outputReserveTokens: args.requestedMaxTokens ?? 1,
    projectRequest: () => ({ ...request, stop: [...request.stop] }),
  });
  guard.assertBeforeAttempt();
  const result = await invokeCancellable(
    args.invoke(request, Math.max(120_000, maxTokens * 2_000)),
    args.cancel,
    args.signal,
  );
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("text" in result) ||
    typeof result.text !== "string" ||
    !("incomplete" in result) ||
    typeof result.incomplete !== "boolean"
  ) {
    throw new ElizaError(
      "iOS native generation did not return complete status metadata",
      {
        code: "MODEL_NATIVE_RESPONSE_INVALID",
        context: { provider: args.provider, model: args.model },
      },
    );
  }
  if (result.incomplete) {
    throw new ElizaError(
      "The iOS local model exhausted its generation boundary before completing the response",
      {
        code: "MODEL_OUTPUT_INCOMPLETE",
        context: {
          provider: args.provider,
          model: args.model,
          ...("finish_reason" in result
            ? {
                reason: result.finish_reason,
                finishReason: result.finish_reason,
              }
            : {}),
        },
      },
    );
  }
  return result.text;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

/**
 * Settles with the native call, or rejects at once on abort. Whenever the call
 * ends without a result (abort, host timeout, transport error), the native
 * decode is told to stop so it does not keep the session busy.
 */
async function invokeCancellable(
  pending: Promise<unknown>,
  cancel: (() => Promise<unknown>) | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const sendCancel = () => {
    // error-policy:J5 best-effort stop; the caller already has its own error.
    cancel?.().catch(() => {});
  };
  if (signal?.aborted) {
    pending.catch(() => {});
    sendCancel();
    throw abortReason(signal);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      if (signal) reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    pending.catch(() => {});
    sendCancel();
    throw error;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export function stripReasoningBlocks(raw: string): string {
  return raw
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/\/?\bno_think\b/gi, "")
    .trim();
}

export function cleanIosNativeConversationReply(raw: string): string {
  const withoutTokens = stripReasoningBlocks(raw)
    .split("<end_of_turn>")[0]
    .split("<start_of_turn>")[0]
    .split("<|im_end|>")[0]
    .split("<|im_start|>")[0]
    .replace(/^\s*model\s*:\s*/i, "")
    .replace(/^\s*(assistant|eliza)\s*:\s*/i, "")
    .trim();
  return withoutTokens;
}
