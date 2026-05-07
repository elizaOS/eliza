/** ACTION_STATE Provider - Provides action results and working memory to the LLM. */
import {
  addHeader,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import type { MultiStepActionResult } from "../types";

function formatActionResult(result: MultiStepActionResult, index: number): string {
  const actionName = result.data?.actionName || "Unknown Action";
  const status = result.success ? "Success" : "Failed";
  const lines = [`**${index + 1}. ${actionName}** - ${status}`];

  if (result.text) lines.push(`   Output: ${result.text}`);
  if (result.error) {
    const errorStr = result.error instanceof Error ? result.error.message : String(result.error);
    lines.push(`   Error: ${errorStr}`);
  }
  if (result.values && Object.keys(result.values).length > 0) {
    const values = Object.entries(result.values)
      .map(([key, value]) => `   - ${key}: ${JSON.stringify(value)}`)
      .join("\n");
    lines.push(`   Values:\n${values}`);
  }
  const toolCallId = (result.data as Record<string, unknown> | undefined)?.toolCallId;
  if (typeof toolCallId === "string" && toolCallId.trim()) {
    lines.push(`   Tool Call ID: ${toolCallId}`);
  }

  return lines.join("\n");
}

function formatWorkingMemory(workingMemory: Record<string, unknown>): string {
  type MemEntry = {
    actionName?: string;
    result?: { text?: string; data?: unknown };
    timestamp?: number;
  };

  return Object.entries(workingMemory)
    .sort((a, b) => ((b[1] as MemEntry)?.timestamp || 0) - ((a[1] as MemEntry)?.timestamp || 0))
    .slice(0, 10)
    .map(([key, value]) => {
      const v = value as MemEntry;
      if (v.actionName && v.result) {
        return `**${v.actionName}**: ${v.result.text || JSON.stringify(v.result.data)}`;
      }
      return `**${key}**: ${JSON.stringify(value)}`;
    })
    .join("\n");
}

function formatActionMemories(memories: Memory[]): string {
  const groupedByRun = new Map<string, Memory[]>();
  for (const mem of memories) {
    const runId = String(mem.content?.runId || "unknown");
    const group = groupedByRun.get(runId) || [];
    group.push(mem);
    groupedByRun.set(runId, group);
  }

  return Array.from(groupedByRun.entries())
    .map(([runId, mems]) => {
      const sorted = mems.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const runText = sorted
        .map((mem) => {
          const actionName = mem.content?.actionName || "Unknown";
          const status = mem.content?.actionStatus || "unknown";
          const planStep = mem.content?.planStep || "";
          const text = mem.content?.text || "";
          let line = `  - ${actionName} (${status})`;
          if (planStep) line += ` [${planStep}]`;
          if (text && text !== `Executed action: ${actionName}`) line += `: ${text}`;
          return line;
        })
        .join("\n");
      const thought = sorted[0]?.content?.planThought || "";
      return `**Run ${runId.slice(0, 8)}**${thought ? ` - ${thought}` : ""}\n${runText}`;
    })
    .join("\n\n");
}

export const actionStateProvider: Provider = {
  name: "ACTION_STATE",
  description: "Previous action results and working memory from the current execution run",
  position: 150,

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Check state.data first, then message metadata as fallback
    // This handles the timing issue where actionResults may be in message metadata
    // before state is fully composed
    const messageMetadata = (message.content?.metadata || {}) as Record<string, unknown>;
    const actionResults = (state.data?.actionResults ||
      messageMetadata.actionResults ||
      []) as MultiStepActionResult[];
    const workingMemory = (state.data?.workingMemory || {}) as Record<string, unknown>;

    // Format action results
    const resultsText =
      actionResults.length > 0
        ? addHeader("# Previous Action Results", actionResults.map(formatActionResult).join("\n\n"))
        : "No previous action results available.";

    // Format working memory
    const memoryText =
      Object.keys(workingMemory).length > 0
        ? addHeader("# Working Memory", formatWorkingMemory(workingMemory))
        : "";

    let recentActionMemories: Memory[] = [];
    try {
      const recentMessages = await runtime.getMemories({
        tableName: "messages",
        roomId: message.roomId,
        count: 20,
        unique: false,
      });
      recentActionMemories = recentMessages.filter(
        (msg) =>
          (msg.content?.type as string) === "action_result" &&
          (msg.metadata?.type as string) === "action_result",
      );
    } catch (error) {
      logger.warn(
        `[ACTION_STATE] Failed to retrieve action memories for room ${message.roomId} - action history will be incomplete: ${error}`,
      );
    }

    // Format action history
    const actionMemoriesText =
      recentActionMemories.length > 0
        ? addHeader("# Recent Action History", formatActionMemories(recentActionMemories))
        : "";

    const allText = [resultsText, memoryText, actionMemoriesText].filter(Boolean).join("\n\n");

    return {
      data: { actionResults, workingMemory, recentActionMemories },
      values: {
        hasActionResults: actionResults.length > 0,
        actionResults: resultsText,
        completedActions: actionResults.filter((r) => r.success).length,
        failedActions: actionResults.filter((r) => !r.success).length,
      },
      text: allText || "No action state available",
    };
  },
};
