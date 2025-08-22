import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";

interface ModelInfo {
  id: string;
  provider: string;
  type: string;
  description?: string;
}

const AVAILABLE_MODELS: ModelInfo[] = [
  // OpenAI
  {
    id: "openai:gpt-4o",
    provider: "OpenAI",
    type: "text",
    description: "Most capable GPT-4 model",
  },
  {
    id: "openai:gpt-4o-mini",
    provider: "OpenAI",
    type: "text",
    description: "Fast and affordable GPT-4",
  },
  {
    id: "openai:gpt-3.5-turbo",
    provider: "OpenAI",
    type: "text",
    description: "Fast and efficient",
  },
  {
    id: "openai:dall-e-3",
    provider: "OpenAI",
    type: "image",
    description: "Advanced image generation",
  },
  {
    id: "openai:text-embedding-3-small",
    provider: "OpenAI",
    type: "embedding",
    description: "Small embedding model",
  },
  {
    id: "openai:text-embedding-3-large",
    provider: "OpenAI",
    type: "embedding",
    description: "Large embedding model",
  },
  {
    id: "openai:whisper-1",
    provider: "OpenAI",
    type: "audio",
    description: "Speech to text",
  },

  // Anthropic
  {
    id: "anthropic:claude-3-5-sonnet",
    provider: "Anthropic",
    type: "text",
    description: "Claude 3.5 Sonnet",
  },
  {
    id: "anthropic:claude-3-opus",
    provider: "Anthropic",
    type: "text",
    description: "Most capable Claude",
  },
  {
    id: "anthropic:claude-3-haiku",
    provider: "Anthropic",
    type: "text",
    description: "Fast Claude model",
  },

  // Google
  {
    id: "google:gemini-2.0-flash",
    provider: "Google",
    type: "text",
    description: "Gemini 2.0 Flash",
  },
  {
    id: "google:gemini-1.5-pro",
    provider: "Google",
    type: "text",
    description: "Gemini Pro",
  },
  {
    id: "google:gemini-1.5-flash",
    provider: "Google",
    type: "text",
    description: "Fast Gemini model",
  },

  // Meta
  {
    id: "meta:llama-3.1-405b",
    provider: "Meta",
    type: "text",
    description: "Largest Llama model",
  },
  {
    id: "meta:llama-3.1-70b",
    provider: "Meta",
    type: "text",
    description: "Large Llama model",
  },
  {
    id: "meta:llama-3.1-8b",
    provider: "Meta",
    type: "text",
    description: "Small Llama model",
  },

  // Mistral
  {
    id: "mistral:mistral-large",
    provider: "Mistral",
    type: "text",
    description: "Large Mistral model",
  },
  {
    id: "mistral:mistral-medium",
    provider: "Mistral",
    type: "text",
    description: "Medium Mistral model",
  },
  {
    id: "mistral:mistral-small",
    provider: "Mistral",
    type: "text",
    description: "Small Mistral model",
  },
];

export const listModelsAction: Action = {
  name: "LIST_MODELS",
  description: "List available AI models from the gateway",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || "";
    return (
      text.includes("model") ||
      text.includes("list") ||
      text.includes("available") ||
      text.includes("show")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<void> => {
    const content = message.content;
    const filterType = (content as any).type?.toLowerCase();
    const filterProvider = (content as any).provider?.toLowerCase();

    let models = [...AVAILABLE_MODELS];

    // Apply filters
    if (filterType) {
      models = models.filter((m) => m.type === filterType);
    }
    if (filterProvider) {
      models = models.filter(
        (m) => m.provider.toLowerCase() === filterProvider,
      );
    }

    // Group by provider
    const grouped = models.reduce(
      (acc, model) => {
        if (!acc[model.provider]) {
          acc[model.provider] = [];
        }
        acc[model.provider].push(model);
        return acc;
      },
      {} as Record<string, ModelInfo[]>,
    );

    // Format output
    let output = "Available AI Models:\n\n";
    for (const [provider, providerModels] of Object.entries(grouped)) {
      output += `**${provider}:**\n`;
      for (const model of providerModels) {
        output += `  • ${model.id} (${model.type})`;
        if (model.description) {
          output += ` - ${model.description}`;
        }
        output += "\n";
      }
      output += "\n";
    }

    if (callback) {
      await callback({
        text: output,
        models: models,
        success: true,
      });
    }

    return;
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "List available models",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Here are the available AI models...",
          action: "LIST_MODELS",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Show me text generation models",
          type: "text",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Available text generation models...",
          action: "LIST_MODELS",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "What OpenAI models are available?",
          provider: "openai",
        },
      },
      {
        name: "assistant",
        content: {
          text: "OpenAI models available through the gateway...",
          action: "LIST_MODELS",
        },
      },
    ],
  ],

  similes: ["show_models", "available_models", "model_list", "get_models"],
};
