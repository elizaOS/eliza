import { IAgentRuntime, logger, Memory, ModelType, composePromptFromState } from '@elizaos/core';

export async function callLLMWithTimeout<T>(
  runtime: IAgentRuntime,
  state: any, // Can be State or null/undefined if not directly relevant to prompt composition
  template: string,
  actionName: string,
  messageText: string, // Added to pass the raw message content
  timeoutMs: number = 30000 // Default timeout of 30 seconds
): Promise<T | null> {
  try {
    logger.info(`[${actionName}] Calling LLM with timeout for template:`, template);

    const prompt = composePromptFromState(template, {
      message: { content: { text: messageText } as Memory['content'] },
      state, // Pass the state if needed by the template
    });

    // Simulate LLM call. In a real scenario, this would use runtime.useModel
    const mockLLMResponse = {
      tokenSymbolOrAddress: messageText.includes('USDC')
        ? 'USDC'
        : messageText.includes('WMATIC')
          ? 'WMATIC'
          : null,
    }; // Very basic mock, will need to be expanded for other actions

    // Simulate delay or processing time
    await new Promise((resolve) => setTimeout(resolve, 500));

    return mockLLMResponse as T;
  } catch (error) {
    logger.error(`[${actionName}] Error calling LLM with timeout:`, error);
    return null;
  }
}
