import type {
  ActionResult,
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "../../types/index.ts";
import { addHeader } from "../../utils.ts";

/**
 * Provider for sharing action execution state and plan between actions
 * Makes previous action results and execution plan available to subsequent actions
 */
export const actionStateProvider: Provider = {
  name: "ACTION_STATE",
  description:
    "Previous action results, working memory, and action plan from the current execution run",
  position: 150,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const actionResults = state.data.actionResults ?? [];
    const actionPlan = state.data.actionPlan;
    const workingMemory = state.data.workingMemory;

    // Format action plan for display
    let planText = "";
    if (actionPlan && actionPlan.totalSteps > 1) {
      const completedSteps = actionPlan.steps.filter(
        (s) => s.status === "completed",
      ).length;
      const failedSteps = actionPlan.steps.filter(
        (s) => s.status === "failed",
      ).length;

      planText = addHeader(
        "# Action Execution Plan",
        [
          `**Plan:** ${actionPlan.thought}`,
          `**Progress:** Step ${actionPlan.currentStep} of ${actionPlan.totalSteps}`,
          `**Status:** ${completedSteps} completed, ${failedSteps} failed`,
          "",
          "## Steps:",
          ...actionPlan.steps.map((step, index: number) => {
            const icon =
              step.status === "completed"
                ? "✓"
                : step.status === "failed"
                  ? "✗"
                  : index < actionPlan.currentStep - 1
                    ? "○"
                    : index === actionPlan.currentStep - 1
                      ? "→"
                      : "○";
            const status =
              step.status === "pending" && index === actionPlan.currentStep - 1
                ? "in progress"
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
          "",
        ].join("\n"),
      );
    }

    // Format previous action results
    let resultsText = "";
    if (actionResults.length > 0) {
      const formattedResults = actionResults
        .map((result, index) => {
          const actionNameValue = result.data?.actionName;
          const actionName =
            typeof actionNameValue === "string"
              ? actionNameValue
              : "Unknown Action";
          const success = result.success;
          const status = success ? "Success" : "Failed";

          let resultText = `**${index + 1}. ${actionName}** - ${status}`;

          if (result.text) {
            resultText += `\n   Output: ${result.text}`;
          }

          if (result.error) {
            const errorMsg =
              result.error instanceof Error
                ? result.error.message
                : result.error;
            resultText += `\n   Error: ${errorMsg}`;
          }

          if (result.values && Object.keys(result.values).length > 0) {
            const values = Object.entries(result.values)
              .map(([key, value]) => `   - ${key}: ${JSON.stringify(value)}`)
              .join("\n");
            resultText += `\n   Values:\n${values}`;
          }

          return resultText;
        })
        .join("\n\n");

      resultsText = addHeader("# Previous Action Results", formattedResults);
    } else {
      resultsText = "No previous action results available.";
    }

    // Format working memory
    let memoryText = "";
    if (workingMemory && Object.keys(workingMemory).length > 0) {
      const memoryEntries = Object.entries(workingMemory)
        .sort((a, b) => b[1].timestamp - a[1].timestamp)
        .slice(0, 10) // Show last 10 entries
        .map(([key, entry]) => {
          const result: ActionResult = entry.result;
          const resultText =
            typeof result.text === "string" && result.text.trim().length > 0
              ? result.text
              : result.data
                ? JSON.stringify(result.data)
                : "(no output)";
          return `**${entry.actionName || key}**: ${resultText}`;
        })
        .join("\n");

      memoryText = addHeader("# Working Memory", memoryEntries);
    }

    // Get recent action result memories from the database
    // Get messages with type 'action_result' from the room
    const recentMessages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: 20,
      unique: false,
    });

    const recentActionMemories = recentMessages.filter(
      (msg) => msg.content && msg.content.type === "action_result",
    );

    // Format recent action memories
    let actionMemoriesText = "";
    if (recentActionMemories.length > 0) {
      // Group by runId using Map
      const groupedByRun = new Map<string, Memory[]>();

      for (const mem of recentActionMemories) {
        const runId: string = String(mem.content?.runId || "unknown");
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
            (a: Memory, b: Memory) => (a.createdAt || 0) - (b.createdAt || 0),
          );

          const runText = sortedMemories
            .map((mem: Memory) => {
              const memContent = mem.content;
              const actionName = memContent?.actionName || "Unknown";
              const status = memContent?.actionStatus || "unknown";
              const planStep = memContent?.planStep || "";
              const text = memContent?.text || "";

              let memText = `  - ${actionName} (${status})`;
              if (planStep) {
                memText += ` [${planStep}]`;
              }
              if (text && text !== `Executed action: ${actionName}`) {
                memText += `: ${text}`;
              }

              return memText;
            })
            .join("\n");

          const firstMemory = sortedMemories[0];
          const thought = firstMemory?.content?.planThought || "";
          return `**Run ${runId.slice(0, 8)}**${thought ? ` - ${thought}` : ""}\n${runText}`;
        })
        .join("\n\n");

      actionMemoriesText = addHeader(
        "# Recent Action History",
        formattedMemories,
      );
    }

    // Combine all text sections
    const allText = [planText, resultsText, memoryText, actionMemoriesText]
      .filter(Boolean)
      .join("\n\n");

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
        actionResults: resultsText,
        completedActions: actionResults.filter((r) => r.success).length,
        failedActions: actionResults.filter((r) => !r.success).length,
      },
      text: allText || "No action state available",
    };
  },
};
