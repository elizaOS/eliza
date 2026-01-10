/**
 * @elizaos/plugin-polymarket LLM Helpers
 *
 * Utilities for calling LLM models with timeout and parsing responses.
 */

import {
  type IAgentRuntime,
  type State,
  ModelType,
  composePromptFromState,
  logger,
} from "@elizaos/core";
import { LLM_CALL_TIMEOUT_MS } from "../constants";

/**
 * Call LLM with a timeout and parse JSON response
 *
 * @param runtime - The agent runtime
 * @param state - Current conversation state
 * @param template - The prompt template
 * @param actionName - Name of the action (for logging)
 * @param timeoutMs - Timeout in milliseconds (default: 60000)
 * @returns Parsed JSON response from LLM
 */
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

  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    // Race between LLM call and timeout
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

    // Try to extract JSON from the response
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
      logger.error(`[${actionName}] Failed to parse LLM response as JSON: ${error.message}`);
    } else {
      logger.error(`[${actionName}] LLM call error: ${String(error)}`);
    }
    return null;
  }
}

/**
 * Extract a specific field from LLM response
 *
 * @param runtime - The agent runtime
 * @param state - Current conversation state
 * @param template - The prompt template
 * @param fieldName - Name of the field to extract
 * @param actionName - Name of the action (for logging)
 * @returns The extracted field value or null
 */
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

/**
 * Check if LLM response indicates an error
 */
export function isLLMError(
  response: Record<string, unknown> | null
): response is { error: string } {
  return response !== null && typeof response === "object" && "error" in response;
}
