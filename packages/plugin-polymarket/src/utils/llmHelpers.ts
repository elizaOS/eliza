import {
  type IAgentRuntime,
  type State,
  ModelType,
  composePromptFromState,
  logger,
} from '@elizaos/core';

/**
 * Calls the LLM with timeout handling to prevent hanging
 * @param runtime - The agent runtime
 * @param state - The current state
 * @param template - The prompt template to use
 * @param actionName - Name of the action for logging
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @returns Promise resolving to the LLM response
 */
export async function callLLMWithTimeout<T = any>(
  runtime: IAgentRuntime,
  state: State | undefined,
  template: string,
  actionName: string,
  timeoutMs: number = 30000
): Promise<T> {
  logger.info(`[${actionName}] Starting LLM parameter extraction...`);

  // Add timeout to prevent hanging
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`LLM call timed out after ${timeoutMs / 1000} seconds`)),
      timeoutMs
    );
  });

  const llmPromise = runtime.useModel(ModelType.OBJECT_LARGE, {
    prompt: composePromptFromState({
      state,
      template,
    }),
  });

  const result = (await Promise.race([llmPromise, timeoutPromise])) as T;

  logger.info(`[${actionName}] LLM parameter extraction completed`);
  logger.debug(`[${actionName}] Parsed LLM parameters:`, result);

  return result;
}
