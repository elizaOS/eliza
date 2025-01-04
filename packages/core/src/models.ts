import settings from "./settings.ts";
import { Models, ModelProviderName, ModelClass } from "./types.ts";

export const models: Models = {
    [ModelProviderName.OPENAI]: {
        endpoint: settings.OPENAI_API_URL || "https://api.openai.com/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            temperature: 0.6,
        },
        model: {
            [ModelClass.SMALL]: settings.SMALL_OPENAI_MODEL || "gpt-4o-mini",
            [ModelClass.MEDIUM]: settings.MEDIUM_OPENAI_MODEL || "gpt-4o",
            [ModelClass.LARGE]: settings.LARGE_OPENAI_MODEL || "gpt-4o",
            [ModelClass.EMBEDDING]: settings.EMBEDDING_OPENAI_MODEL || "text-embedding-3-small",
            [ModelClass.IMAGE]: settings.IMAGE_OPENAI_MODEL || "dall-e-3",
        },
    },
    [ModelProviderName.ETERNALAI]: {
        endpoint: settings.ETERNALAI_URL,
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            temperature: 0.6,
        },
        model: {
            [ModelClass.SMALL]:
                settings.ETERNALAI_MODEL ||
                "neuralmagic/Meta-Llama-3.1-405B-Instruct-quantized.w4a16",
            [ModelClass.MEDIUM]:
                settings.ETERNALAI_MODEL ||
                "neuralmagic/Meta-Llama-3.1-405B-Instruct-quantized.w4a16",
            [ModelClass.LARGE]:
                settings.ETERNALAI_MODEL ||
                "neuralmagic/Meta-Llama-3.1-405B-Instruct-quantized.w4a16",
            [ModelClass.EMBEDDING]: "",
            [ModelClass.IMAGE]: "",
        },
    },
    [ModelProviderName.ANTHROPIC]: {
        settings: {
            stop: [],
            maxInputTokens: 200000,
            maxOutputTokens: 4096,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.7,
        },
        endpoint: "https://api.anthropic.com/v1",
        model: {
            [ModelClass.SMALL]: settings.SMALL_ANTHROPIC_MODEL || "claude-3-haiku-20240307",
            [ModelClass.MEDIUM]: settings.MEDIUM_ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
            [ModelClass.LARGE]: settings.LARGE_ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
        },
    },
    [ModelProviderName.CLAUDE_VERTEX]: {
        settings: {
            stop: [],
            maxInputTokens: 200000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.7,
        },
        endpoint: "https://api.anthropic.com/v1", // TODO: check
        model: {
            [ModelClass.SMALL]: "claude-3-5-sonnet-20241022",
            [ModelClass.MEDIUM]: "claude-3-5-sonnet-20241022",
            [ModelClass.LARGE]: "claude-3-opus-20240229",
        },
    },
    [ModelProviderName.GROK]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.7,
        },
        endpoint: "https://api.x.ai/v1",
        model: {
            [ModelClass.SMALL]: settings.SMALL_GROK_MODEL || "grok-2-1212",
            [ModelClass.MEDIUM]: settings.MEDIUM_GROK_MODEL || "grok-2-1212",
            [ModelClass.LARGE]: settings.LARGE_GROK_MODEL || "grok-2-1212",
            [ModelClass.EMBEDDING]: settings.EMBEDDING_GROK_MODEL || "grok-2-1212", // not sure about this one
        },
    },
    [ModelProviderName.GROQ]: {
        endpoint: "https://api.groq.com/openai/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8000,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.7,
        },
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_GROQ_MODEL || "llama-3.1-8b-instant",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_GROQ_MODEL || "llama-3.3-70b-versatile",
            [ModelClass.LARGE]:
                settings.LARGE_GROQ_MODEL || "llama-3.2-90b-vision-preview",
            [ModelClass.EMBEDDING]:
                settings.EMBEDDING_GROQ_MODEL || "llama-3.1-8b-instant",
        },
    },
    [ModelProviderName.LLAMACLOUD]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            repetition_penalty: 0.4,
            temperature: 0.7,
        },
        imageSettings: {
            steps: 4,
        },
        endpoint: "https://api.llamacloud.com/v1",
        model: {
            [ModelClass.SMALL]: "meta-llama/Llama-3.2-3B-Instruct-Turbo",
            [ModelClass.MEDIUM]: "meta-llama-3.1-8b-instruct",
            [ModelClass.LARGE]: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
            [ModelClass.EMBEDDING]:
                "togethercomputer/m2-bert-80M-32k-retrieval",
            [ModelClass.IMAGE]: "black-forest-labs/FLUX.1-schnell",
        },
    },
    [ModelProviderName.TOGETHER]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            repetition_penalty: 0.4,
            temperature: 0.7,
        },
        imageSettings: {
            steps: 4,
        },
        endpoint: "https://api.together.ai/v1",
        model: {
            [ModelClass.SMALL]: "meta-llama/Llama-3.2-3B-Instruct-Turbo",
            [ModelClass.MEDIUM]: "meta-llama-3.1-8b-instruct",
            [ModelClass.LARGE]: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
            [ModelClass.EMBEDDING]:
                "togethercomputer/m2-bert-80M-32k-retrieval",
            [ModelClass.IMAGE]: "black-forest-labs/FLUX.1-schnell",
        },
    },
    [ModelProviderName.LLAMALOCAL]: {
        settings: {
            stop: ["<|eot_id|>", "<|eom_id|>"],
            maxInputTokens: 32768,
            maxOutputTokens: 8192,
            repetition_penalty: 0.4,
            temperature: 0.7,
        },
        model: {
            [ModelClass.SMALL]:
                "NousResearch/Hermes-3-Llama-3.1-8B-GGUF/resolve/main/Hermes-3-Llama-3.1-8B.Q8_0.gguf?download=true",
            [ModelClass.MEDIUM]:
                "NousResearch/Hermes-3-Llama-3.1-8B-GGUF/resolve/main/Hermes-3-Llama-3.1-8B.Q8_0.gguf?download=true", // TODO: ?download=true
            [ModelClass.LARGE]:
                "NousResearch/Hermes-3-Llama-3.1-8B-GGUF/resolve/main/Hermes-3-Llama-3.1-8B.Q8_0.gguf?download=true",
            // "RichardErkhov/NousResearch_-_Meta-Llama-3.1-70B-gguf", // TODO:
            [ModelClass.EMBEDDING]:
                "togethercomputer/m2-bert-80M-32k-retrieval",
        },
    },
    [ModelProviderName.GOOGLE]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.7,
        },
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_GOOGLE_MODEL ||
                settings.GOOGLE_MODEL ||
                "gemini-1.5-flash-latest",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_GOOGLE_MODEL ||
                settings.GOOGLE_MODEL ||
                "gemini-1.5-flash-latest",
            [ModelClass.LARGE]:
                settings.LARGE_GOOGLE_MODEL ||
                settings.GOOGLE_MODEL ||
                "gemini-1.5-pro-latest",
            [ModelClass.EMBEDDING]:
                settings.EMBEDDING_GOOGLE_MODEL ||
                settings.GOOGLE_MODEL ||
                "text-embedding-004",
        },
    },
    [ModelProviderName.REDPILL]: {
        endpoint: "https://api.red-pill.ai/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            temperature: 0.6,
        },
        // Available models: https://docs.red-pill.ai/get-started/supported-models
        // To test other models, change the models below
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_REDPILL_MODEL ||
                settings.REDPILL_MODEL ||
                "gpt-4o-mini",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_REDPILL_MODEL ||
                settings.REDPILL_MODEL ||
                "gpt-4o",
            [ModelClass.LARGE]:
                settings.LARGE_REDPILL_MODEL ||
                settings.REDPILL_MODEL ||
                "gpt-4o",
            [ModelClass.EMBEDDING]: "text-embedding-3-small",
        },
    },
    [ModelProviderName.OPENROUTER]: {
        endpoint: "https://openrouter.ai/api/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.7,
        },
        // Available models: https://openrouter.ai/models
        // To test other models, change the models below
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_OPENROUTER_MODEL ||
                settings.OPENROUTER_MODEL ||
                "nousresearch/hermes-3-llama-3.1-405b",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_OPENROUTER_MODEL ||
                settings.OPENROUTER_MODEL ||
                "nousresearch/hermes-3-llama-3.1-405b",
            [ModelClass.LARGE]:
                settings.LARGE_OPENROUTER_MODEL ||
                settings.OPENROUTER_MODEL ||
                "nousresearch/hermes-3-llama-3.1-405b",
            [ModelClass.EMBEDDING]: "text-embedding-3-small",
        },
    },
    [ModelProviderName.OLLAMA]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.7,
        },
        endpoint: settings.OLLAMA_SERVER_URL || "http://localhost:11434",
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_OLLAMA_MODEL ||
                settings.OLLAMA_MODEL ||
                "llama3.2",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_OLLAMA_MODEL ||
                settings.OLLAMA_MODEL ||
                "hermes3",
            [ModelClass.LARGE]:
                settings.LARGE_OLLAMA_MODEL ||
                settings.OLLAMA_MODEL ||
                "hermes3:70b",
            [ModelClass.EMBEDDING]:
                settings.OLLAMA_EMBEDDING_MODEL || "mxbai-embed-large",
        },
    },
    [ModelProviderName.HEURIST]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            repetition_penalty: 0.4,
            temperature: 0.7,
        },
        imageSettings: {
            steps: 20,
        },
        endpoint: "https://llm-gateway.heurist.xyz",
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_HEURIST_MODEL ||
                "meta-llama/llama-3-70b-instruct",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_HEURIST_MODEL ||
                "meta-llama/llama-3-70b-instruct",
            [ModelClass.LARGE]:
                settings.LARGE_HEURIST_MODEL ||
                "meta-llama/llama-3.1-405b-instruct",
            [ModelClass.EMBEDDING]: "", //Add later,
            [ModelClass.IMAGE]: settings.HEURIST_IMAGE_MODEL || "PepeXL",
        },
    },
    [ModelProviderName.GALADRIEL]: {
        endpoint: "https://api.galadriel.com/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.5,
            presence_penalty: 0.5,
            temperature: 0.8,
        },
        model: {
            [ModelClass.SMALL]: "llama3.1:70b",
            [ModelClass.MEDIUM]: "llama3.1:70b",
            [ModelClass.LARGE]: "llama3.1:405b",
            [ModelClass.EMBEDDING]: "gte-large-en-v1.5",
            [ModelClass.IMAGE]: "stabilityai/stable-diffusion-xl-base-1.0",
        },
    },
    [ModelProviderName.FAL]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            repetition_penalty: 0.4,
            temperature: 0.7,
        },
        imageSettings: {
            steps: 28,
        },
        endpoint: "https://api.fal.ai/v1",
        model: {
            [ModelClass.SMALL]: "", // FAL doesn't provide text models
            [ModelClass.MEDIUM]: "",
            [ModelClass.LARGE]: "",
            [ModelClass.EMBEDDING]: "",
            [ModelClass.IMAGE]: "fal-ai/flux-lora",
        },
    },
    [ModelProviderName.GAIANET]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            repetition_penalty: 0.4,
            temperature: 0.7,
        },
        endpoint: settings.GAIANET_SERVER_URL,
        model: {
            [ModelClass.SMALL]:
                settings.GAIANET_MODEL ||
                settings.SMALL_GAIANET_MODEL ||
                "llama3b",
            [ModelClass.MEDIUM]:
                settings.GAIANET_MODEL ||
                settings.MEDIUM_GAIANET_MODEL ||
                "llama",
            [ModelClass.LARGE]:
                settings.GAIANET_MODEL ||
                settings.LARGE_GAIANET_MODEL ||
                "qwen72b",
            [ModelClass.EMBEDDING]:
                settings.GAIANET_EMBEDDING_MODEL || "nomic-embed",
        },
    },
    [ModelProviderName.ALI_BAILIAN]: {
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.6,
        },
        model: {
            [ModelClass.SMALL]: "qwen-turbo",
            [ModelClass.MEDIUM]: "qwen-plus",
            [ModelClass.LARGE]: "qwen-max",
            [ModelClass.IMAGE]: "wanx-v1",
        },
    },
    [ModelProviderName.VOLENGINE]: {
        endpoint: settings.VOLENGINE_API_URL || "https://open.volcengineapi.com/api/v3/",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.4,
            presence_penalty: 0.4,
            temperature: 0.6,
        },
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_VOLENGINE_MODEL ||
                settings.VOLENGINE_MODEL ||
                "doubao-lite-128k",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_VOLENGINE_MODEL ||
                settings.VOLENGINE_MODEL ||
                "doubao-pro-128k",
            [ModelClass.LARGE]:
                settings.LARGE_VOLENGINE_MODEL ||
                settings.VOLENGINE_MODEL ||
                "doubao-pro-256k",
            [ModelClass.EMBEDDING]:
                settings.VOLENGINE_EMBEDDING_MODEL ||
                "doubao-embedding",
        },
    },
    [ModelProviderName.NANOGPT]: {
        endpoint: "https://nano-gpt.com/api/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            temperature: 0.6,
        },
        model: {
            [ModelClass.SMALL]: settings.SMALL_NANOGPT_MODEL || "gpt-4o-mini",
            [ModelClass.MEDIUM]: settings.MEDIUM_NANOGPT_MODEL || "gpt-4o",
            [ModelClass.LARGE]: settings.LARGE_NANOGPT_MODEL || "gpt-4o",
        }
    },
    [ModelProviderName.HYPERBOLIC]: {
        endpoint: "https://api.hyperbolic.xyz/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            temperature: 0.6,
        },
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_HYPERBOLIC_MODEL ||
                settings.HYPERBOLIC_MODEL ||
                "meta-llama/Llama-3.2-3B-Instruct",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_HYPERBOLIC_MODEL ||
                settings.HYPERBOLIC_MODEL ||
                "meta-llama/Meta-Llama-3.1-70B-Instruct",
            [ModelClass.LARGE]:
                settings.LARGE_HYPERBOLIC_MODEL ||
                settings.HYPERBOLIC_MODEL ||
                "meta-llama/Meta-Llama-3.1-405-Instruct",
            [ModelClass.IMAGE]: settings.IMAGE_HYPERBOLIC_MODEL || "FLUX.1-dev",
        },
    },
    [ModelProviderName.VENICE]: {
        endpoint: "https://api.venice.ai/api/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            temperature: 0.6,
        },
        model: {
            [ModelClass.SMALL]: settings.SMALL_VENICE_MODEL || "llama-3.3-70b",
            [ModelClass.MEDIUM]: settings.MEDIUM_VENICE_MODEL || "llama-3.3-70b",
            [ModelClass.LARGE]: settings.LARGE_VENICE_MODEL || "llama-3.1-405b",
            [ModelClass.IMAGE]: settings.IMAGE_VENICE_MODEL || "fluently-xl",
        },
    },
    [ModelProviderName.AKASH_CHAT_API]: {
        endpoint: "https://chatapi.akash.network/api/v1",
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            temperature: 0.6,
        },
        model: {
            [ModelClass.SMALL]:
                settings.SMALL_AKASH_CHAT_API_MODEL ||
                "Meta-Llama-3-2-3B-Instruct",
            [ModelClass.MEDIUM]:
                settings.MEDIUM_AKASH_CHAT_API_MODEL ||
                "Meta-Llama-3-3-70B-Instruct",
            [ModelClass.LARGE]:
                settings.LARGE_AKASH_CHAT_API_MODEL ||
                "Meta-Llama-3-1-405B-Instruct-FP8",
        },
    },
    [ModelProviderName.LIVEPEER]: {
        settings: {
            stop: [],
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
            repetition_penalty: 0.4,
            temperature: 0.7,
        },
        // livepeer endpoint is handled from the sdk
        model: {
            [ModelClass.SMALL]: "",
            [ModelClass.MEDIUM]: "",
            [ModelClass.LARGE]: "",
            [ModelClass.EMBEDDING]: "",
            [ModelClass.IMAGE]: settings.LIVEPEER_IMAGE_MODEL || "ByteDance/SDXL-Lightning",
        },
    },
};

export function getModel(provider: ModelProviderName, type: ModelClass) {
    return models[provider].model[type];
}

export function getEndpoint(provider: ModelProviderName) {
    return models[provider].endpoint;
}
