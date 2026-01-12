import {
  composePromptFromState,
  type IAgentRuntime,
  logger,
  ModelType,
  type State,
} from "@elizaos/core";
import { LLM_CALL_TIMEOUT_MS } from "../constants";

export async function callLLMWithTimeout<T>(
  runtime: IAgentRuntime,
  state: State | undefined,
  template: string,
  actionName: string,
  timeoutMs: number = LLM_CALL_TIMEOUT_MS
): Promise<T | null> {
  const composedPrompt = composePromptFromState({
    state: state ?? ({} as State),
    template,
  });

  logger.debug(`[${actionName}] Calling LLM with prompt:`, composedPrompt);

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const response = await Promise.race([
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: composedPrompt,
      }),
      timeoutPromise,
    ]);

    if (!response) {
      logger.warn(`[${actionName}] Empty response from LLM`);
      return null;
    }

    const text = typeof response === "string" ? response : String(response);
    logger.debug(`[${actionName}] LLM response:`, text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`[${actionName}] No JSON found in LLM response`);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as T;
    logger.debug(`[${actionName}] Parsed LLM response: ${JSON.stringify(parsed)}`);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse LLM response as JSON: ${error.message}`);
    }
    throw error;
  }
}

export async function extractFieldFromLLM<T>(
  runtime: IAgentRuntime,
  state: State | undefined,
  template: string,
  fieldName: string,
  actionName: string
): Promise<T | null> {
  const result = await callLLMWithTimeout<Record<string, unknown>>(
    runtime,
    state,
    template,
    actionName
  );

  if (!result) {
    return null;
  }

  if (fieldName in result) {
    return result[fieldName] as T;
  }

  return null;
}

export function isLLMError<T extends object>(
  response: T | null
): response is T & { error: string } {
  return (
    response !== null &&
    typeof response === "object" &&
    "error" in response &&
    typeof (response as { error?: unknown }).error === "string"
  );
}
