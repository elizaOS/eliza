import {
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { DEFAULT_MAX_RETRIES, type ValidationResult } from "../types";
import { parseJSON } from "./json";

export interface WithModelRetryOptions<T> {
  runtime: IAgentRuntime;
  message: Memory;
  state: State;
  input: string | object;
  validationFn: (data: unknown) => ValidationResult<T>;
  createFeedbackPromptFn: (
    original: string | object,
    error: string,
    state: State,
    userMsg: string,
  ) => string;
  callback?: HandlerCallback;
  failureMsg?: string;
  retryCount?: number;
}

/**
 * Retries model selection with feedback on parse errors
 */
export async function withModelRetry<T>({
  runtime,
  message,
  state,
  callback,
  input,
  validationFn,
  createFeedbackPromptFn,
  failureMsg,
  retryCount = 0,
}: WithModelRetryOptions<T>): Promise<T | null> {
  const maxRetries = getMaxRetries(runtime);

  try {
    const parsed = typeof input === "string" ? parseJSON<unknown>(input) : input;
    const result = validationFn(parsed);
    if (!result.success) throw new Error(result.error);
    return result.data as T;
  } catch (e) {
    const error = e instanceof Error ? e.message : "Parse error";
    logger.error({ error }, "[Retry] Parse failed");

    if (retryCount < maxRetries) {
      const feedback = createFeedbackPromptFn(input, error, state, message.content.text || "");
      const retry = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: feedback,
      });
      return withModelRetry({
        runtime,
        input: retry,
        validationFn,
        message,
        state,
        createFeedbackPromptFn,
        callback,
        failureMsg,
        retryCount: retryCount + 1,
      });
    }

    if (callback && failureMsg) {
      await callback({
        text: failureMsg,
        thought: "Parse failed after retries",
        actions: ["REPLY"],
      });
    }
    return null;
  }
}

function getMaxRetries(runtime: IAgentRuntime): number {
  try {
    const mcp = runtime.getSetting("mcp") as
      | Record<string, unknown>
      | string
      | boolean
      | number
      | null;
    if (mcp && typeof mcp === "object" && "maxRetries" in mcp && mcp.maxRetries !== undefined) {
      const val = Number(mcp.maxRetries);
      if (!isNaN(val) && val >= 0) return val;
    }
  } catch (e) {
    logger.debug(
      { error: e instanceof Error ? e.message : e },
      "[Retry] Failed to get maxRetries setting",
    );
  }
  return DEFAULT_MAX_RETRIES;
}
