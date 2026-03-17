import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import {
  decodeMemoryText,
  type ForgetParameters,
  MEMORY_SOURCE,
  PLUGIN_MEMORY_TABLE,
} from "../types.js";

export const forgetAction: Action = {
  name: "FORGET",
  description: "Remove a stored memory by ID or by matching content description",
  similes: ["forget", "remove-memory", "delete-memory", "erase-memory", "clear-memory"],

  examples: [
    [
      {
        name: "User",
        content: { text: "Forget what you know about my favorite color." },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll remove that memory about your favorite color.",
          actions: ["FORGET"],
        },
      },
    ],
    [
      {
        name: "User",
        content: { text: "Delete the memory about the project deadline." },
      },
      {
        name: "Assistant",
        content: {
          text: "I've removed the memory about the project deadline.",
          actions: ["FORGET"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    return typeof runtime.getMemories === "function" && typeof runtime.deleteMemory === "function";
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const content = message.content.text;
      if (!content) {
        const errorMessage = "Please specify which memory to forget.";
        await callback?.({ text: errorMessage, source: message.content.source });
        return { text: errorMessage, success: false };
      }

      const params = _options?.parameters as ForgetParameters | undefined;

      // Direct removal by ID if provided
      if (params?.memoryId) {
        await runtime.deleteMemory(params.memoryId as import("@elizaos/core").UUID);
        const successMessage = `Removed memory with ID: ${params.memoryId}`;
        await callback?.({ text: successMessage, source: message.content.source });
        return { text: successMessage, success: true, data: { removedId: params.memoryId } };
      }

      // Search for matching memory to remove
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: PLUGIN_MEMORY_TABLE,
        count: 100,
      });

      const pluginMemories = memories.filter((m) => m.content.source === MEMORY_SOURCE);

      if (pluginMemories.length === 0) {
        const noMemoriesMsg = "No stored memories found to remove.";
        await callback?.({ text: noMemoriesMsg, source: message.content.source });
        return { text: noMemoriesMsg, success: true };
      }

      // Use LLM to identify which memory to forget
      const searchContent = params?.content ?? content;
      const memoryDescriptions = pluginMemories.map((m, i) => {
        const parsed = decodeMemoryText(m.content.text);
        return `${i}: "${parsed.content}"`;
      });

      const matchPrompt = `Given the user's request to forget a memory, identify which stored memory index matches best.

User request: "${searchContent}"

Available memories:
${memoryDescriptions.join("\n")}

Return ONLY a JSON object (no markdown, no code blocks):
{"index": <number or -1 if no match>, "confidence": <0.0 to 1.0>}`;

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: matchPrompt,
      });

      if (!response) {
        throw new Error("Failed to identify memory to remove");
      }

      const cleaned = response
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
      const match: { index: number; confidence: number } = JSON.parse(cleaned);

      if (match.index < 0 || match.index >= pluginMemories.length || match.confidence < 0.5) {
        const noMatchMsg = "Could not find a matching memory to remove. Please be more specific.";
        await callback?.({ text: noMatchMsg, source: message.content.source });
        return { text: noMatchMsg, success: false };
      }

      const targetMemory = pluginMemories[match.index];
      const parsed = decodeMemoryText(targetMemory.content.text);
      const memoryId = targetMemory.id ?? "";

      if (memoryId) {
        await runtime.deleteMemory(memoryId as import("@elizaos/core").UUID);
      }

      const successMessage = `Removed memory: "${parsed.content}"`;
      await callback?.({ text: successMessage, source: message.content.source });

      return {
        text: successMessage,
        success: true,
        data: { removedId: memoryId, content: parsed.content },
      };
    } catch (error) {
      logger.error("Failed to forget memory:", error);
      const errorMessage = `Failed to forget memory: ${error instanceof Error ? error.message : String(error)}`;
      await callback?.({ text: errorMessage, source: message.content.source });
      return { text: errorMessage, success: false };
    }
  },
};
