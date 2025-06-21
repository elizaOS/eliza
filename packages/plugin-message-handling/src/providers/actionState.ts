import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';

/**
 * Provider that exposes current and previous action execution state
 * This allows actions to see what has been executed before them
 * and access the working memory for the conversation
 */
export const actionStateProvider: Provider = {
  name: 'ACTION_STATE',
  description: 'Current and previous action execution state',
  position: -5, // Very high priority

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get action results from state cache - this is a runtime internal property
    // We'll access it through the state data passed from processActions
    const actionResults = state.data?.actionResults || [];

    // Get working memory if available (will be undefined for now)
    const workingMemory = (runtime as any).getWorkingMemory?.(message.roomId);

    // Get any active plans (for future implementation)
    const activePlan = (runtime as any).getActivePlan?.(message.roomId);

    // Format previous action results
    const formattedResults = actionResults
      .map((result: any, index: number) => {
        return `Step ${index + 1}: ${result.success ? '✓' : '✗'} ${
          result.data?.actionName || 'Unknown Action'
        }${result.error ? ` - Error: ${result.error.message}` : ''}`;
      })
      .join('\n');

    // Format working memory highlights
    const memoryEntries: [string, any][] = workingMemory ? Array.from(workingMemory.entries()) : [];
    const memoryHighlights = memoryEntries
      .slice(-5) // Last 5 entries
      .map(([key, value]: [string, any]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

    // Format plan status if available
    const formatPlan = (plan: any) => {
      if (!plan) return '';
      return `Goal: ${plan.goal}\nSteps: ${plan.steps.length}\nStatus: ${plan.state?.status || 'unknown'}`;
    };

    const text = [
      actionResults.length > 0 && `## Previous Action Results\n${formattedResults}`,
      memoryHighlights && `## Working Memory\n${memoryHighlights}`,
      activePlan && `## Active Plan\n${formatPlan(activePlan)}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      text,
      values: {
        previousActionCount: actionResults.length,
        lastActionSuccess: actionResults[actionResults.length - 1]?.success,
        hasActivePlan: !!activePlan,
        workingMemorySize: memoryEntries.length,
      },
      data: {
        actionResults,
        workingMemory: workingMemory?.serialize?.(),
        activePlan,
      },
    };
  },
};
