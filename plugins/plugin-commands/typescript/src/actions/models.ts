/**
 * Models command action
 *
 * Queries the runtime for actually registered model handlers instead of
 * using a hardcoded list. Falls back to listing registered model types
 * when detailed model info is not available.
 */

import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";
import { detectCommand } from "../parser";

/**
 * Describe a ModelType value in a user-friendly way
 */
function describeModelType(modelType: string): string {
  const descriptions: Record<string, string> = {
    [ModelType.TEXT_SMALL]: "Text (Small)",
    [ModelType.TEXT_LARGE]: "Text (Large)",
    [ModelType.TEXT_REASONING_SMALL]: "Reasoning (Small)",
    [ModelType.TEXT_REASONING_LARGE]: "Reasoning (Large)",
    [ModelType.TEXT_COMPLETION]: "Text Completion",
    [ModelType.TEXT_EMBEDDING]: "Embedding",
    [ModelType.IMAGE]: "Image Generation",
    [ModelType.IMAGE_DESCRIPTION]: "Image Description",
    [ModelType.TRANSCRIPTION]: "Transcription",
    [ModelType.TEXT_TO_SPEECH]: "Text-to-Speech",
    [ModelType.AUDIO]: "Audio",
    [ModelType.VIDEO]: "Video",
    [ModelType.OBJECT_SMALL]: "Object (Small)",
    [ModelType.OBJECT_LARGE]: "Object (Large)",
    [ModelType.RESEARCH]: "Research",
  };
  return descriptions[modelType] ?? modelType;
}

export const modelsAction: Action = {
  name: "MODELS_COMMAND",
  description:
    "List available AI models and providers. Only activates for /models slash command.",
  // Only slash-command similes to avoid matching natural language
  similes: ["/models"],

  async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message.content?.text ?? "";
    // Strict: only activate for slash commands, never natural language
    const detection = detectCommand(text);
    return detection.isCommand && detection.command?.key === "models";
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ) {
    const lines: string[] = ["**Available Models:**\n"];

    // Query runtime for registered model handlers
    try {
      const registeredTypes: string[] = [];
      const seen = new Set<string>();

      // Check each ModelType to see if a handler is registered.
      // Deduplicate since ModelType has legacy aliases (SMALL, MEDIUM, LARGE)
      // that map to the same underlying values.
      for (const modelType of Object.values(ModelType)) {
        if (seen.has(modelType)) continue;
        seen.add(modelType);
        try {
          // runtime.getModel() returns the handler or undefined
          const handler = runtime.getModel(modelType);
          if (handler) {
            registeredTypes.push(modelType);
          }
        } catch {
          // Model type not registered
        }
      }

      if (registeredTypes.length > 0) {
        lines.push("**Registered Model Types:**");
        for (const modelType of registeredTypes) {
          lines.push(`• ${describeModelType(modelType)} (\`${modelType}\`)`);
        }
      } else {
        lines.push("No model handlers are currently registered.");
      }

      // Show current model settings if available
      const modelProvider = runtime.getSetting("MODEL_PROVIDER");
      const modelName = runtime.getSetting("MODEL_NAME");
      if (modelProvider || modelName) {
        lines.push("\n**Current Configuration:**");
        if (modelProvider) lines.push(`• Provider: ${modelProvider}`);
        if (modelName) lines.push(`• Model: ${modelName}`);
      }
    } catch (err) {
      logger.warn(
        { src: "plugin-commands", err },
        "Error querying runtime models",
      );
      lines.push("Unable to query available models.");
    }

    lines.push("\n\n_Use /model <provider/model> to switch models._");

    const replyText = lines.join("\n");
    await callback?.({ text: replyText });

    return {
      success: true,
      text: replyText,
    };
  },

  examples: [
    [
      { user: "user", content: { text: "/models" } },
      {
        user: "assistant",
        content: {
          text: "**Available Models:**\n\n**Registered Model Types:**\n• Text (Large) (`text_large`)\n• Text (Small) (`text_small`)...",
        },
      },
    ],
  ] as ActionExample[][],
};
