import {
  type HandlerCallback,
  type IAgentRuntime,
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

  const parsedJson = typeof input === "string" ? parseJSON<Record<string, unknown>>(input) : input;

  const validationResult = validationFn(parsedJson);

  if (validationResult.success) {
    return validationResult.data;
  }

  const errorMessage = (validationResult as { success: false; error: string }).error;

  if (retryCount < maxRetries) {
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
      actions: ["REPLY"],
    });
  }

  return null;
}

function getMaxRetries(runtime: IAgentRuntime): number {
  const rawSettings = runtime.getSetting("mcp");

  if (rawSettings && typeof rawSettings === "object") {
    const settings = rawSettings as McpSettings;
    if (typeof settings.maxRetries === "number" && settings.maxRetries >= 0) {
      return settings.maxRetries;
    }
  }

  return DEFAULT_MAX_RETRIES;
}
