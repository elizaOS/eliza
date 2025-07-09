import {
  addHeader,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  logger,
} from '@elizaos/core';

/**
 * Provider for sharing action execution state and plan between actions
 * Makes previous action results and execution plan available to subsequent actions
 */
export const actionStateProvider: Provider = {
  name: 'ACTION_STATE',
  description:
    'Previous action results, working memory, and action plan from the current execution run',
  position: 150,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get action results, plan, and working memory from the incoming state
    const actionResults = state.data?.actionResults || [];
    const actionPlan = state.data?.actionPlan || null;
    const workingMemory = state.data?.workingMemory || {};

    // Format action plan for display
    let planText = '';
    if (actionPlan && actionPlan.totalSteps > 1) {
      const completedSteps = actionPlan.steps.filter((s: any) => s.status === 'completed').length;
      const failedSteps = actionPlan.steps.filter((s: any) => s.status === 'failed').length;

      planText = addHeader(
        '# Action Execution Plan',
        [
          `**Plan:** ${actionPlan.thought}`,
          `**Progress:** Step ${actionPlan.currentStep} of ${actionPlan.totalSteps}`,
          `**Status:** ${completedSteps} completed, ${failedSteps} failed`,
          '',
          '## Steps:',
          ...actionPlan.steps.map((step: any, index: number) => {
            const icon =
              step.status === 'completed'
                ? '✓'
                : step.status === 'failed'
                  ? '✗'
                  : index < actionPlan.currentStep - 1
                    ? '○'
                    : index === actionPlan.currentStep - 1
                      ? '→'
                      : '○';
            const status =
              step.status === 'pending' && index === actionPlan.currentStep - 1
                ? 'in progress'
                : step.status;
            let stepText = `${icon} **Step ${index + 1}:** ${step.action} (${status})`;

            if (step.error) {
              stepText += `\n   Error: ${step.error}`;
            }
            if (step.result?.text) {
              stepText += `\n   Result: ${step.result.text}`;
            }

            return stepText;
          }),
          '',
        ].join('\n')
      );
    }

    // Format previous action results
    let resultsText = '';
    if (actionResults.length > 0) {
      const formattedResults = actionResults
        .map((result: any, index: number) => {
          const actionName = result.data?.actionName || 'Unknown Action';
          const success = result.success; // Now required field
          const status = success ? 'Success' : 'Failed';

          let resultText = `**${index + 1}. ${actionName}** - ${status}`;

          if (result.text) {
            resultText += `\n   Output: ${result.text}`;
          }

          if (result.error) {
            resultText += `\n   Error: ${result.error}`;
          }

          if (result.values && Object.keys(result.values).length > 0) {
            const values = Object.entries(result.values)
              .map(([key, value]) => `   - ${key}: ${JSON.stringify(value)}`)
              .join('\n');
            resultText += `\n   Values:\n${values}`;
          }

          return resultText;
        })
        .join('\n\n');

      resultsText = addHeader('# Previous Action Results', formattedResults);
    }

    // Format working memory
    let memoryText = '';
    if (Object.keys(workingMemory).length > 0) {
      const memoryEntries = Object.entries(workingMemory)
        .sort((a: any, b: any) => (b[1].timestamp || 0) - (a[1].timestamp || 0))
        .slice(0, 10) // Show last 10 entries
        .map(([key, value]: [string, any]) => {
          if (value.actionName && value.result) {
            return `**${value.actionName}**: ${value.result.text || JSON.stringify(value.result.data)}`;
          }
          return `**${key}**: ${JSON.stringify(value)}`;
        })
        .join('\n');

      memoryText = addHeader('# Working Memory', memoryEntries);
    }

    // Get recent action result memories from the database
    let recentActionMemories: Memory[] = [];
    try {
      // Get messages with type 'action_result' from the room
      const recentMessages = await runtime.getMemories({
        tableName: 'messages',
        roomId: message.roomId,
        count: 20,
        unique: false,
      });

      recentActionMemories = recentMessages.filter(
        (msg) => msg.content?.type === 'action_result' && msg.metadata?.type === 'action_result'
      );
    } catch (error) {
      logger?.error('Failed to retrieve action memories:', error);
    }

    // Format recent action memories
    let actionMemoriesText = '';
    if (recentActionMemories.length > 0) {
      // Group by runId using Map
      const groupedByRun = new Map<string, Memory[]>();

      for (const mem of recentActionMemories) {
        const runId: string = String(mem.content?.runId || 'unknown');
        if (!groupedByRun.has(runId)) {
          groupedByRun.set(runId, []);
        }
        const memories = groupedByRun.get(runId);
        if (memories) {
          memories.push(mem);
        }
      }

      const formattedMemories = Array.from(groupedByRun.entries())
        .map(([runId, memories]) => {
          const sortedMemories = memories.sort(
            (a: Memory, b: Memory) => (a.createdAt || 0) - (b.createdAt || 0)
          );

          const runText = sortedMemories
            .map((mem: Memory) => {
              const actionName = mem.content?.actionName || 'Unknown';
              const status = mem.content?.actionStatus || 'unknown';
              const planStep = mem.content?.planStep || '';
              const text = mem.content?.text || '';

              let memText = `  - ${actionName} (${status})`;
              if (planStep) memText += ` [${planStep}]`;
              if (text && text !== `Executed action: ${actionName}`) {
                memText += `: ${text}`;
              }

              return memText;
            })
            .join('\n');

          const thought = sortedMemories[0]?.content?.planThought || '';
          return `**Run ${runId.slice(0, 8)}**${thought ? ` - ${thought}` : ''}\n${runText}`;
        })
        .join('\n\n');

      actionMemoriesText = addHeader('# Recent Action History', formattedMemories);
    }

    // Combine all text sections
    const allText = [planText, resultsText, memoryText, actionMemoriesText]
      .filter(Boolean)
      .join('\n\n');

    return {
      data: {
        actionResults,
        actionPlan,
        workingMemory,
        recentActionMemories,
      },
      values: {
        hasActionResults: actionResults.length > 0,
        hasActionPlan: !!actionPlan,
        currentActionStep: actionPlan?.currentStep || 0,
        totalActionSteps: actionPlan?.totalSteps || 0,
        completedActions: actionResults.filter((r: any) => r.success).length,
        failedActions: actionResults.filter((r: any) => !r.success).length,
      },
      text: allText || 'No action state available',
    };
  },
};
