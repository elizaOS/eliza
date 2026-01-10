import {
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { DEFAULT_MAX_RETRIES, type McpSettings, type ValidationResult } from "../types";
import { parseJSON } from "./json";

export type Input = string | Record<string, unknown>;

type CreateFeedbackPromptFn = (
  originalResponse: Input,
  errorMessage: string,
  composedState: State,
  userMessage: string
) => string;

export interface WithModelRetryOptions<T> {
  readonly runtime: IAgentRuntime;
  readonly message: Memory;
  readonly state: State;
  readonly input: Input;
  readonly validationFn: (data: Input) => ValidationResult<T>;
  readonly createFeedbackPromptFn: CreateFeedbackPromptFn;
  readonly callback?: HandlerCallback;
  readonly failureMsg?: string;
  readonly retryCount?: number;
}

/**
 * Retries the model selection process in case of parsing errors.
 * Uses fail-fast approach - throws on unrecoverable errors.
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

  logger.info(`[WITH-MODEL-RETRY] Raw selection input:\n${JSON.stringify(input)}`);

  // If input is a string, parse it to JSON
  const parsedJson = typeof input === "string" ? parseJSON<Record<string, unknown>>(input) : input;

  logger.debug(
    `[WITH-MODEL-RETRY] Parsed selection input:\n${JSON.stringify(parsedJson, null, 2)}`
  );

  const validationResult = validationFn(parsedJson);

  if (validationResult.success) {
    return validationResult.data;
  }

  const errorMessage = (validationResult as { success: false; error: string }).error;
  logger.error({ errorMessage }, `[WITH-MODEL-RETRY] Validation failed: ${errorMessage}`);

  if (retryCount < maxRetries) {
    logger.debug(`[WITH-MODEL-RETRY] Retrying (attempt ${retryCount + 1}/${maxRetries})`);

    const feedbackPrompt: string = createFeedbackPromptFn(
      input,
      errorMessage,
      state,
      message.content.text ?? ""
    );

    const retrySelection = (await runtime.useModel(ModelType.OBJECT_LARGE, {
      prompt: feedbackPrompt,
    })) as Record<string, unknown>;

    return withModelRetry({
      runtime,
      input: retrySelection,
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
      thought:
        "Failed to parse response after multiple retries. Requesting clarification from user.",
      actions: ["REPLY"],
    });
  }

  return null;
}

/**
 * Retrieves the maximum number of retries for MCP selection from the agent runtime settings.
 */
function getMaxRetries(runtime: IAgentRuntime): number {
  const rawSettings = runtime.getSetting("mcp");

  if (rawSettings && typeof rawSettings === "object") {
    const settings = rawSettings as McpSettings;
    if (typeof settings.maxRetries === "number" && settings.maxRetries >= 0) {
      logger.debug(`[WITH-MODEL-RETRY] Using configured selection retries: ${settings.maxRetries}`);
      return settings.maxRetries;
    }
  }

  return DEFAULT_MAX_RETRIES;
}
