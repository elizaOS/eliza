import settings from "./settings.ts";
import {
    type EmbeddingModelSettings,
    type ImageModelSettings,
    ModelClass,
    ModelProviderName,
    type Models,
    type ModelSettings,
} from "./types.ts";

export const models: Models = {
    [ModelProviderName.OPENAI]: {
        endpoint: settings.OPENAI_API_URL || "https://api.openai.com/v1",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_OPENAI_MODEL || "gpt-4o-mini",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_OPENAI_MODEL || "gpt-4o",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_OPENAI_MODEL || "gpt-4o",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.EMBEDDING]: {
                name:
                    settings.EMBEDDING_OPENAI_MODEL || "text-embedding-3-small",
                dimensions: 1536,
            },
            [ModelClass.IMAGE]: {
                name: settings.IMAGE_OPENAI_MODEL || "dall-e-3",
            },
        },
    },
    [ModelProviderName.ETERNALAI]: {
        endpoint: settings.ETERNALAI_URL,
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.ETERNALAI_MODEL ||
                    "neuralmagic/Meta-Llama-3.1-405B-Instruct-quantized.w4a16",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.ETERNALAI_MODEL ||
                    "neuralmagic/Meta-Llama-3.1-405B-Instruct-quantized.w4a16",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.ETERNALAI_MODEL ||
                    "neuralmagic/Meta-Llama-3.1-405B-Instruct-quantized.w4a16",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
        },
    },
    [ModelProviderName.ANTHROPIC]: {
        endpoint: "https://api.anthropic.com/v1",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_ANTHROPIC_MODEL || "claude-3-haiku-20240307",
                stop: [],
                maxInputTokens: 200000,
                maxOutputTokens: 4096,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_ANTHROPIC_MODEL ||
                    "claude-3-5-sonnet-20241022",
                stop: [],
                maxInputTokens: 200000,
                maxOutputTokens: 4096,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },

            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_ANTHROPIC_MODEL ||
                    "claude-3-5-sonnet-20241022",
                stop: [],
                maxInputTokens: 200000,
                maxOutputTokens: 4096,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
        },
    },
    [ModelProviderName.CLAUDE_VERTEX]: {
        endpoint: "https://api.anthropic.com/v1", // TODO: check
        model: {
            [ModelClass.SMALL]: {
                name: "claude-3-5-sonnet-20241022",
                stop: [],
                maxInputTokens: 200000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name: "claude-3-5-sonnet-20241022",
                stop: [],
                maxInputTokens: 200000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name: "claude-3-opus-20240229",
                stop: [],
                maxInputTokens: 200000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
        },
    },
    [ModelProviderName.GROK]: {
        endpoint: "https://api.x.ai/v1",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_GROK_MODEL || "grok-2-1212",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_GROK_MODEL || "grok-2-1212",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_GROK_MODEL || "grok-2-1212",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.EMBEDDING]: {
                name: settings.EMBEDDING_GROK_MODEL || "grok-2-1212", // not sure about this one
            },
        },
    },
    [ModelProviderName.GROQ]: {
        endpoint: "https://api.groq.com/openai/v1",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_GROQ_MODEL || "llama-3.1-8b-instant",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8000,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_GROQ_MODEL || "llama-3.3-70b-versatile",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8000,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_GROQ_MODEL || "llama-3.2-90b-vision-preview",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8000,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.EMBEDDING]: {
                name: settings.EMBEDDING_GROQ_MODEL || "llama-3.1-8b-instant",
            },
        },
    },
    [ModelProviderName.LLAMACLOUD]: {
        endpoint: "https://api.llamacloud.com/v1",
        model: {
            [ModelClass.SMALL]: {
                name: "meta-llama/Llama-3.2-3B-Instruct-Turbo",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name: "meta-llama-3.1-8b-instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.EMBEDDING]: {
                name: "togethercomputer/m2-bert-80M-32k-retrieval",
            },
            [ModelClass.IMAGE]: {
                name: "black-forest-labs/FLUX.1-schnell",
                steps: 4,
            },
        },
    },
    [ModelProviderName.TOGETHER]: {
        endpoint: "https://api.together.ai/v1",
        model: {
            [ModelClass.SMALL]: {
                name: "meta-llama/Llama-3.2-3B-Instruct-Turbo",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo-128K",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.EMBEDDING]: {
                name: "togethercomputer/m2-bert-80M-32k-retrieval",
            },
            [ModelClass.IMAGE]: {
                name: "black-forest-labs/FLUX.1-schnell",
                steps: 4,
            },
        },
    },
    [ModelProviderName.LLAMALOCAL]: {
        model: {
            [ModelClass.SMALL]: {
                name: "NousResearch/Hermes-3-Llama-3.1-8B-GGUF/resolve/main/Hermes-3-Llama-3.1-8B.Q8_0.gguf?download=true",
                stop: ["<|eot_id|>", "<|eom_id|>"],
                maxInputTokens: 32768,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name: "NousResearch/Hermes-3-Llama-3.1-8B-GGUF/resolve/main/Hermes-3-Llama-3.1-8B.Q8_0.gguf?download=true", // TODO: ?download=true
                stop: ["<|eot_id|>", "<|eom_id|>"],
                maxInputTokens: 32768,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name: "NousResearch/Hermes-3-Llama-3.1-8B-GGUF/resolve/main/Hermes-3-Llama-3.1-8B.Q8_0.gguf?download=true", // "RichardErkhov/NousResearch_-_Meta-Llama-3.1-70B-gguf", // TODO:
                stop: ["<|eot_id|>", "<|eom_id|>"],
                maxInputTokens: 32768,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.EMBEDDING]: {
                name: "togethercomputer/m2-bert-80M-32k-retrieval",
            },
        },
    },
    [ModelProviderName.LMSTUDIO]: {
        endpoint: settings.LMSTUDIO_SERVER_URL || "http://localhost:1234/v1",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_LMSTUDIO_MODEL || settings.LMSTUDIO_MODEL || "hermes-3-llama-3.1-8b",
                stop: ["<|eot_id|>", "<|eom_id|>"],
                maxInputTokens: 32768,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_LMSTUDIO_MODEL || settings.LMSTUDIO_MODEL || "hermes-3-llama-3.1-8b",
                stop: ["<|eot_id|>", "<|eom_id|>"],
                maxInputTokens: 32768,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_LMSTUDIO_MODEL || settings.LMSTUDIO_MODEL || "hermes-3-llama-3.1-8b",
                stop: ["<|eot_id|>", "<|eom_id|>"],
                maxInputTokens: 32768,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
        },
    },
    [ModelProviderName.GOOGLE]: {
        endpoint: "https://generativelanguage.googleapis.com",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_GOOGLE_MODEL ||
                    settings.GOOGLE_MODEL ||
                    "gemini-2.0-flash-exp",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_GOOGLE_MODEL ||
                    settings.GOOGLE_MODEL ||
                    "gemini-2.0-flash-exp",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_GOOGLE_MODEL ||
                    settings.GOOGLE_MODEL ||
                    "gemini-2.0-flash-exp",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.EMBEDDING]: {
                name:
                    settings.EMBEDDING_GOOGLE_MODEL ||
                    settings.GOOGLE_MODEL ||
                    "text-embedding-004",
            },
        },
    },
    [ModelProviderName.MISTRAL]: {
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_MISTRAL_MODEL ||
                    settings.MISTRAL_MODEL ||
                    "mistral-small-latest",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_MISTRAL_MODEL ||
                    settings.MISTRAL_MODEL ||
                    "mistral-large-latest",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_MISTRAL_MODEL ||
                    settings.MISTRAL_MODEL ||
                    "mistral-large-latest",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
        },
    },
    [ModelProviderName.REDPILL]: {
        endpoint: "https://api.red-pill.ai/v1",
        // Available models: https://docs.red-pill.ai/get-started/supported-models
        // To test other models, change the models below
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_REDPILL_MODEL ||
                    settings.REDPILL_MODEL ||
                    "gpt-4o-mini",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_REDPILL_MODEL ||
                    settings.REDPILL_MODEL ||
                    "gpt-4o",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },

            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_REDPILL_MODEL ||
                    settings.REDPILL_MODEL ||
                    "gpt-4o",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },

            [ModelClass.EMBEDDING]: {
                name: "text-embedding-3-small",
            },
        },
    },
    [ModelProviderName.OPENROUTER]: {
        endpoint: "https://openrouter.ai/api/v1",
        // Available models: https://openrouter.ai/models
        // To test other models, change the models below
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_OPENROUTER_MODEL ||
                    settings.OPENROUTER_MODEL ||
                    "nousresearch/hermes-3-llama-3.1-405b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_OPENROUTER_MODEL ||
                    settings.OPENROUTER_MODEL ||
                    "nousresearch/hermes-3-llama-3.1-405b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_OPENROUTER_MODEL ||
                    settings.OPENROUTER_MODEL ||
                    "nousresearch/hermes-3-llama-3.1-405b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.EMBEDDING]: {
                name: "text-embedding-3-small",
            },
        },
    },
    [ModelProviderName.OLLAMA]: {
        endpoint: settings.OLLAMA_SERVER_URL || "http://localhost:11434",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_OLLAMA_MODEL ||
                    settings.OLLAMA_MODEL ||
                    "llama3.2",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_OLLAMA_MODEL ||
                    settings.OLLAMA_MODEL ||
                    "hermes3",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },

            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_OLLAMA_MODEL ||
                    settings.OLLAMA_MODEL ||
                    "hermes3:70b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.7,
            },

            [ModelClass.EMBEDDING]: {
                name: settings.OLLAMA_EMBEDDING_MODEL || "mxbai-embed-large",
                dimensions: 1024,
            },
        },
    },
    [ModelProviderName.HEURIST]: {
        endpoint: "https://llm-gateway.heurist.xyz",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_HEURIST_MODEL ||
                    "meta-llama/llama-3-70b-instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_HEURIST_MODEL ||
                    "meta-llama/llama-3-70b-instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_HEURIST_MODEL ||
                    "meta-llama/llama-3.3-70b-instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.IMAGE]: {
                name: settings.HEURIST_IMAGE_MODEL || "FLUX.1-dev",
                steps: 20,
            },
            [ModelClass.EMBEDDING]: {
                name: "BAAI/bge-large-en-v1.5",
                dimensions: 1024,
            },
        },
    },
    [ModelProviderName.GALADRIEL]: {
        endpoint: "https://api.galadriel.com/v1/verified",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_GALADRIEL_MODEL || "gpt-4o-mini",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_GALADRIEL_MODEL || "gpt-4o",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_GALADRIEL_MODEL || "gpt-4o",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
        },
    },
    [ModelProviderName.FAL]: {
        endpoint: "https://api.fal.ai/v1",
        model: {
            [ModelClass.IMAGE]: { name: "fal-ai/flux-lora", steps: 28 },
        },
    },
    [ModelProviderName.GAIANET]: {
        endpoint: settings.GAIANET_SERVER_URL,
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.GAIANET_MODEL ||
                    settings.SMALL_GAIANET_MODEL ||
                    "llama3b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.GAIANET_MODEL ||
                    settings.MEDIUM_GAIANET_MODEL ||
                    "llama",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.GAIANET_MODEL ||
                    settings.LARGE_GAIANET_MODEL ||
                    "qwen72b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                repetition_penalty: 0.4,
                temperature: 0.7,
            },
            [ModelClass.EMBEDDING]: {
                name: settings.GAIANET_EMBEDDING_MODEL || "nomic-embed",
                dimensions: 768,
            },
        },
    },
    [ModelProviderName.ALI_BAILIAN]: {
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: {
            [ModelClass.SMALL]: {
                name: "qwen-turbo",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name: "qwen-plus",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name: "qwen-max",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.6,
            },
            [ModelClass.IMAGE]: {
                name: "wanx-v1",
            },
        },
    },
    [ModelProviderName.VOLENGINE]: {
        endpoint:
            settings.VOLENGINE_API_URL ||
            "https://open.volcengineapi.com/api/v3/",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_VOLENGINE_MODEL ||
                    settings.VOLENGINE_MODEL ||
                    "doubao-lite-128k",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_VOLENGINE_MODEL ||
                    settings.VOLENGINE_MODEL ||
                    "doubao-pro-128k",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_VOLENGINE_MODEL ||
                    settings.VOLENGINE_MODEL ||
                    "doubao-pro-256k",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.4,
                presence_penalty: 0.4,
                temperature: 0.6,
            },
            [ModelClass.EMBEDDING]: {
                name: settings.VOLENGINE_EMBEDDING_MODEL || "doubao-embedding",
            },
        },
    },
    [ModelProviderName.NANOGPT]: {
        endpoint: "https://nano-gpt.com/api/v1",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_NANOGPT_MODEL || "gpt-4o-mini",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_NANOGPT_MODEL || "gpt-4o",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_NANOGPT_MODEL || "gpt-4o",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
            },
        },
    },
    [ModelProviderName.HYPERBOLIC]: {
        endpoint: "https://api.hyperbolic.xyz/v1",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_HYPERBOLIC_MODEL ||
                    settings.HYPERBOLIC_MODEL ||
                    "meta-llama/Llama-3.2-3B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_HYPERBOLIC_MODEL ||
                    settings.HYPERBOLIC_MODEL ||
                    "meta-llama/Meta-Llama-3.1-70B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_HYPERBOLIC_MODEL ||
                    settings.HYPERBOLIC_MODEL ||
                    "meta-llama/Meta-Llama-3.1-405-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.IMAGE]: {
                name: settings.IMAGE_HYPERBOLIC_MODEL || "FLUX.1-dev",
            },
        },
    },
    [ModelProviderName.VENICE]: {
        endpoint: "https://api.venice.ai/api/v1",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_VENICE_MODEL || "llama-3.3-70b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_VENICE_MODEL || "llama-3.3-70b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_VENICE_MODEL || "llama-3.1-405b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.IMAGE]: {
                name: settings.IMAGE_VENICE_MODEL || "fluently-xl",
            },
        },
    },
    [ModelProviderName.NVIDIA]: {
        endpoint: "https://integrate.api.nvidia.com/v1",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_NVIDIA_MODEL || "meta/llama-3.2-3b-instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_NVIDIA_MODEL || "meta/llama-3.3-70b-instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_NVIDIA_MODEL || "meta/llama-3.1-405b-instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
        },
    },
    [ModelProviderName.NINETEEN_AI]: {
        endpoint: "https://api.nineteen.ai/v1",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_NINETEEN_AI_MODEL ||
                    "unsloth/Llama-3.2-3B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_NINETEEN_AI_MODEL ||
                    "unsloth/Meta-Llama-3.1-8B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_NINETEEN_AI_MODEL ||
                    "hugging-quants/Meta-Llama-3.1-70B-Instruct-AWQ-INT4",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.IMAGE]: {
                name:
                    settings.IMAGE_NINETEEN_AI_MODEL ||
                    "dataautogpt3/ProteusV0.4-Lightning",
            },
        },
    },
    [ModelProviderName.AKASH_CHAT_API]: {
        endpoint: "https://chatapi.akash.network/api/v1",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_AKASH_CHAT_API_MODEL ||
                    "Meta-Llama-3-2-3B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_AKASH_CHAT_API_MODEL ||
                    "Meta-Llama-3-3-70B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_AKASH_CHAT_API_MODEL ||
                    "Meta-Llama-3-1-405B-Instruct-FP8",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.6,
            },
        },
    },
    [ModelProviderName.LIVEPEER]: {
        endpoint: settings.LIVEPEER_GATEWAY_URL,
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_LIVEPEER_MODEL ||
                    "meta-llama/Meta-Llama-3.1-8B-Instruct",
                stop: [],
                maxInputTokens: 8000,
                maxOutputTokens: 8192,
                temperature: 0,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_LIVEPEER_MODEL ||
                    "meta-llama/Meta-Llama-3.1-8B-Instruct",
                stop: [],
                maxInputTokens: 8000,
                maxOutputTokens: 8192,
                temperature: 0,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_LIVEPEER_MODEL ||
                    "meta-llama/Meta-Llama-3.1-8B-Instruct",
                stop: [],
                maxInputTokens: 8000,
                maxOutputTokens: 8192,
                temperature: 0,
            },
            [ModelClass.IMAGE]: {
                name:
                    settings.IMAGE_LIVEPEER_MODEL || "ByteDance/SDXL-Lightning",
            },
        },
    },
    [ModelProviderName.INFERA]: {
        endpoint: "https://api.infera.org",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_INFERA_MODEL || "llama3.2:3b",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_INFERA_MODEL || "mistral-nemo:latest",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_INFERA_MODEL || "mistral-small:latest",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0,
            },
        },
    },
    [ModelProviderName.DEEPSEEK]: {
        endpoint: settings.DEEPSEEK_API_URL || "https://api.deepseek.com",
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_DEEPSEEK_MODEL || "deepseek-chat",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_DEEPSEEK_MODEL || "deepseek-chat",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_DEEPSEEK_MODEL || "deepseek-chat",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.7,
            },
        },
    },
    [ModelProviderName.BEDROCK]: {
        model: {
            [ModelClass.SMALL]: {
                name: settings.SMALL_BEDROCK_MODEL || "amazon.nova-micro-v1:0",
                maxInputTokens: 128000,
                maxOutputTokens: 5120,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
                stop: [],
            },
            [ModelClass.MEDIUM]: {
                name: settings.MEDIUM_BEDROCK_MODEL || "amazon.nova-lite-v1:0",
                maxInputTokens: 128000,
                maxOutputTokens: 5120,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
                stop: [],
            },
            [ModelClass.LARGE]: {
                name: settings.LARGE_BEDROCK_MODEL || "amazon.nova-pro-v1:0",
                maxInputTokens: 128000,
                maxOutputTokens: 5120,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
                temperature: 0.6,
                stop: [],
            },
            [ModelClass.EMBEDDING]: {
                name:
                    settings.EMBEDDING_BEDROCK_MODEL ||
                    "amazon.titan-embed-text-v1",
            },
            [ModelClass.IMAGE]: {
                name: settings.IMAGE_BEDROCK_MODEL || "amazon.nova-canvas-v1:0",
            },
        },
    },
    [ModelProviderName.ATOMA]: {
        endpoint: settings.ATOMA_API_URL || "https://api.atoma.network/v1",
        model: {
            [ModelClass.SMALL]: {
                name:
                    settings.SMALL_ATOMA_MODEL ||
                    "meta-llama/Llama-3.3-70B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.7,
            },
            [ModelClass.MEDIUM]: {
                name:
                    settings.MEDIUM_ATOMA_MODEL ||
                    "meta-llama/Llama-3.3-70B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.7,
            },
            [ModelClass.LARGE]: {
                name:
                    settings.LARGE_ATOMA_MODEL ||
                    "meta-llama/Llama-3.3-70B-Instruct",
                stop: [],
                maxInputTokens: 128000,
                maxOutputTokens: 8192,
                temperature: 0.7,
            },
        },
    },
};

export function getModelSettings(
    provider: ModelProviderName,
    type: ModelClass
): ModelSettings | undefined {
    return models[provider]?.model[type] as ModelSettings | undefined;
}

export function getImageModelSettings(
    provider: ModelProviderName
): ImageModelSettings | undefined {
    return models[provider]?.model[ModelClass.IMAGE] as
        | ImageModelSettings
        | undefined;
}

export function getEmbeddingModelSettings(
    provider: ModelProviderName
): EmbeddingModelSettings | undefined {
    return models[provider]?.model[ModelClass.EMBEDDING] as
        | EmbeddingModelSettings
        | undefined;
}

export function getEndpoint(provider: ModelProviderName) {
    return models[provider].endpoint;
}
