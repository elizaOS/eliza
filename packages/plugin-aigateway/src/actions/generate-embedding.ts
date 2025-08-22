import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  ModelType,
  HandlerCallback,
} from "@elizaos/core";

export const generateEmbeddingAction: Action = {
  name: "GENERATE_EMBEDDING",
  description: "Generate text embeddings using AI Gateway embedding models",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const content = message.content;
    return !!content.text || !!content.input;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<void> => {
    const content = message.content;
    const text = content.text || content.input;

    if (!text) {
      if (callback) {
        await callback({
          text: "Please provide text to generate embeddings for.",
          success: false,
        });
      }
      return;
    }

    try {
      const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text,
      });

      if (callback) {
        await callback({
          text: `Generated embedding with ${embedding.length} dimensions`,
          embedding: embedding,
          success: true,
        });
      }

      return;
    } catch (error) {
      // Error occurred while generating embedding

      if (callback) {
        await callback({
          text: "Sorry, I encountered an error while generating the embedding.",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return;
    }
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "Generate an embedding for: The quick brown fox jumps over the lazy dog",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Generated embedding with 1536 dimensions",
          action: "GENERATE_EMBEDDING",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          input: "Artificial intelligence is transforming the world",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Generated embedding with 1536 dimensions",
          action: "GENERATE_EMBEDDING",
        },
      },
    ],
  ],

  similes: ["create_embedding", "text_embedding", "vectorize", "embed_text"],
};
