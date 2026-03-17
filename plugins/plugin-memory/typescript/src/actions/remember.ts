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
  encodeMemoryText,
  MEMORY_SOURCE,
  MemoryImportance,
  PLUGIN_MEMORY_TABLE,
  type RememberParameters,
} from "../types.js";

export const rememberAction: Action = {
  name: "REMEMBER",
  description: "Store a piece of information as a long-term memory for later recall",
  similes: ["remember", "memorize", "store-memory", "save-memory", "note-down"],

  examples: [
    [
      {
        name: "User",
        content: { text: "Remember that my favorite color is blue." },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll remember that your favorite color is blue.",
          actions: ["REMEMBER"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Please memorize this: the project deadline is March 15th.",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "Got it, I've stored that the project deadline is March 15th.",
          actions: ["REMEMBER"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    return typeof runtime.createMemory === "function";
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
        const errorMessage = "Please provide content to remember.";
        await callback?.({ text: errorMessage, source: message.content.source });
        return { text: errorMessage, success: false };
      }

      const params = _options?.parameters as RememberParameters | undefined;
      let memoryText: string = params?.content ?? content;
      let tags: string[] = params?.tags ?? [];
      let importance: MemoryImportance = params?.importance ?? MemoryImportance.NORMAL;

      // Use LLM to extract structured memory if no explicit parameters given
      if (!params?.content) {
        const extractionPrompt = `Extract the key information to remember from this message.
Return ONLY a JSON object (no markdown, no code blocks):
{
  "memory": "The concise fact or information to store",
  "tags": ["relevant", "category", "tags"],
  "importance": 2
}

Importance levels: 1=low, 2=normal, 3=high, 4=critical

User message: "${content}"`;

        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: extractionPrompt,
        });

        if (response) {
          try {
            const cleaned = response
              .replace(/^```(?:json)?\n?/, "")
              .replace(/\n?```$/, "")
              .trim();
            const parsed: { memory?: string; tags?: string[]; importance?: number } =
              JSON.parse(cleaned);
            memoryText = parsed.memory ?? content;
            tags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
            importance =
              typeof parsed.importance === "number"
                ? (parsed.importance as MemoryImportance)
                : MemoryImportance.NORMAL;
          } catch (parseError) {
            logger.warn("Failed to parse memory extraction, using raw content", parseError);
            memoryText = content;
          }
        }
      }

      const encodedText = encodeMemoryText(memoryText, tags, importance);

      const memoryEntry: Memory = {
        agentId: runtime.agentId,
        roomId: message.roomId,
        entityId:
          (message as Memory & { entityId?: string; userId?: string }).entityId ??
          (message as { userId?: string }).userId,
        content: {
          text: encodedText,
          source: MEMORY_SOURCE,
        },
        createdAt: Date.now(),
      };

      await runtime.createMemory(memoryEntry, PLUGIN_MEMORY_TABLE, true);

      const tagSuffix = tags.length > 0 ? ` [tags: ${tags.join(", ")}]` : "";
      const successMessage = `Remembered: "${memoryText}"${tagSuffix}`;
      await callback?.({ text: successMessage, source: message.content.source });

      return {
        text: successMessage,
        success: true,
        data: { content: memoryText, tags, importance },
      };
    } catch (error) {
      logger.error("Failed to store memory:", error);
      const errorMessage = `Failed to store memory: ${error instanceof Error ? error.message : String(error)}`;
      await callback?.({ text: errorMessage, source: message.content.source });
      return { text: errorMessage, success: false };
    }
  },
};
