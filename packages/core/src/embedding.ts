import { getEmbeddingModelSettings, getEndpoint } from "./models.ts";
import { type IAgentRuntime, ModelProviderName } from "./types.ts";
import settings from "./settings.ts";
import elizaLogger from "./logger.ts";
import LocalEmbeddingModelManager from "./localembeddingManager.ts";

interface EmbeddingOptions {
    model: string;
    endpoint: string;
    apiKey?: string;
    length?: number;
    isOllama?: boolean;
    dimensions?: number;
    provider?: string;
}

export const EmbeddingProvider = {
    OpenAI: "OpenAI",
    Ollama: "Ollama",
    GaiaNet: "GaiaNet",
    Heurist: "Heurist",
    BGE: "BGE",
    Custom: "Custom",
} as const;

export type EmbeddingProviderType =
    (typeof EmbeddingProvider)[keyof typeof EmbeddingProvider];

export type EmbeddingConfig = {
    readonly dimensions: number;
    readonly model: string;
    readonly provider: EmbeddingProviderType;
};

export const getEmbeddingConfig = (): EmbeddingConfig => {
    // Check for custom embedding configuration first
    if (settings.USE_CUSTOM_EMBEDDING?.toLowerCase() === "true") {
        // Ensure all custom embedding settings are provided
        if (!settings.CUSTOM_EMBEDDING_DIMENSIONS || !settings.CUSTOM_EMBEDDING_MODEL || 
            !settings.CUSTOM_EMBEDDING_ENDPOINT || !settings.CUSTOM_EMBEDDING_API_KEY) {
            elizaLogger.error("Custom embedding configuration error", {
                dimensions: settings.CUSTOM_EMBEDDING_DIMENSIONS,
                model: settings.CUSTOM_EMBEDDING_MODEL,
                endpoint: settings.CUSTOM_EMBEDDING_ENDPOINT,
                apiKey: settings.CUSTOM_EMBEDDING_API_KEY
            });
            throw new Error('Custom embedding enabled but missing required settings');
        }
        
        return {
            dimensions: Number(settings.CUSTOM_EMBEDDING_DIMENSIONS),
            model: settings.CUSTOM_EMBEDDING_MODEL,
            provider: EmbeddingProvider.Custom,
        };
    }

    return {
        dimensions:
            settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
                ? getEmbeddingModelSettings(ModelProviderName.OPENAI).dimensions
                : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                  ? getEmbeddingModelSettings(ModelProviderName.OLLAMA).dimensions
                  : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                    ? getEmbeddingModelSettings(ModelProviderName.GAIANET)
                          .dimensions
                    : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                      ? getEmbeddingModelSettings(ModelProviderName.HEURIST)
                            .dimensions
                      : 384, // BGE
        model:
            settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
                ? getEmbeddingModelSettings(ModelProviderName.OPENAI).name
                : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                  ? getEmbeddingModelSettings(ModelProviderName.OLLAMA).name
                  : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                    ? getEmbeddingModelSettings(ModelProviderName.GAIANET).name
                    : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                      ? getEmbeddingModelSettings(ModelProviderName.HEURIST).name
                      : "BGE-small-en-v1.5",
        provider:
            settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
                ? "OpenAI"
                : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                  ? "Ollama"
                  : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                    ? "GaiaNet"
                    : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                      ? "Heurist"
                      : "BGE",
    };
};

async function getRemoteEmbedding(
    input: string,
    options: EmbeddingOptions
): Promise<number[]> {
    // Ensure endpoint ends with /v1 for OpenAI
    const baseEndpoint = options.endpoint.endsWith("/v1")
        ? options.endpoint
        : `${options.endpoint}${options.isOllama ? "/v1" : ""}`;

    // Construct full URL
    const fullUrl = `${baseEndpoint}/embeddings`;

    const requestOptions = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(options.apiKey
                ? {
                      Authorization: `Bearer ${options.apiKey}`,
                  }
                : {}),
        },
        body: JSON.stringify({
            input,
            model: options.model,
            dimensions:
                options.dimensions ||
                options.length ||
                getEmbeddingConfig().dimensions, // Prefer dimensions, fallback to length
        }),
    };

    try {
        const response = await fetch(fullUrl, requestOptions);

        if (!response.ok) {
            elizaLogger.error("API Response:", await response.text()); // Debug log
            throw new Error(
                `Embedding API Error: ${response.status} ${response.statusText}`
            );
        }

        interface EmbeddingResponse {
            data: Array<{ embedding: number[] }>;
        }

        const data: EmbeddingResponse = await response.json();
        return data?.data?.[0].embedding;
    } catch (e) {
        elizaLogger.error("Full error details:", e);
        throw e;
    }
}

export function getEmbeddingType(runtime: IAgentRuntime): "local" | "remote" {
    const isNode =
        typeof process !== "undefined" &&
        process.versions != null &&
        process.versions.node != null;

    // Use local embedding if:
    // - Running in Node.js
    // - Not using OpenAI provider
    // - Not forcing OpenAI embeddings
    const isLocal =
        isNode &&
        runtime.character.modelProvider !== ModelProviderName.OPENAI &&
        runtime.character.modelProvider !== ModelProviderName.GAIANET &&
        runtime.character.modelProvider !== ModelProviderName.HEURIST &&
        !settings.USE_OPENAI_EMBEDDING;

    return isLocal ? "local" : "remote";
}

export function getEmbeddingZeroVector(): number[] {
    let embeddingDimension = 384; // Default BGE dimension

    if (settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = getEmbeddingModelSettings(
            ModelProviderName.OPENAI
        ).dimensions; // OpenAI dimension
    } else if (settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = getEmbeddingModelSettings(
            ModelProviderName.OLLAMA
        ).dimensions; // Ollama mxbai-embed-large dimension
    } else if (settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = getEmbeddingModelSettings(
            ModelProviderName.GAIANET
        ).dimensions; // GaiaNet dimension
    } else if (settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = getEmbeddingModelSettings(
            ModelProviderName.HEURIST
        ).dimensions; // Heurist dimension
    }

    return Array(embeddingDimension).fill(0);
}

/**
 * Gets embeddings from a remote API endpoint.  Falls back to local BGE/384
 *
 * @param {IAgentRuntime} runtime - The agent runtime context
 * @param {string} input - The text to generate embeddings for
 * @returns {Promise<number[]>} Array of embedding values
 * @throws {Error} If the API request fails
 */
export async function embed(
    runtime: IAgentRuntime,
    input: unknown,
): Promise<number[]> {
    // Coerce non-string inputs to strings so embedding callers are more robust
    let text: string;
    if (typeof input === "string") {
        text = input;
    } else if (input == null) {
        text = "";
    } else {
        try {
            text = JSON.stringify(input);
        } catch (e) {
            text = String(input);
        }
    }

    elizaLogger.debug("Embedding request:", {
        modelProvider: runtime.character.modelProvider,
        useOpenAI: process.env.USE_OPENAI_EMBEDDING,
        inputPreview: (text || "").slice(0, 50) + "...",
        inputType: typeof input,
        inputLength: text.length,
        isString: typeof input === "string",
        isEmpty: !text,
    });

    // If input is empty after coercion, return a zero-vector of correct dim
    if (!text || text.trim().length === 0) {
        elizaLogger.warn("Empty embedding input after coercion; returning zero vector");
        return getEmbeddingZeroVector();
    }

    // Check cache first
    const cachedEmbedding = await retrieveCachedEmbedding(runtime, input);
    if (cachedEmbedding) return cachedEmbedding;

    const config = getEmbeddingConfig();
    const isNode = typeof process !== "undefined" && process.versions?.node;
  
    if (config.provider === EmbeddingProvider.Custom) {
      return await getRemoteEmbedding(input, {
        model: config.model,
        endpoint: settings.CUSTOM_EMBEDDING_ENDPOINT,
        apiKey: settings.CUSTOM_EMBEDDING_API_KEY,
        dimensions: config.dimensions,
      });
    }

    // Determine which embedding path to use
    if (config.provider === EmbeddingProvider.OpenAI) {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint: settings.OPENAI_API_URL || "https://api.openai.com/v1",
            apiKey: settings.OPENAI_API_KEY,
            dimensions: config.dimensions,
        });
    }

    if (config.provider === EmbeddingProvider.Ollama) {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint:
                runtime.character.modelEndpointOverride ||
                getEndpoint(ModelProviderName.OLLAMA),
            isOllama: true,
            dimensions: config.dimensions,
        });
    }

    if (config.provider == EmbeddingProvider.GaiaNet) {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint:
                runtime.character.modelEndpointOverride ||
                getEndpoint(ModelProviderName.GAIANET) ||
                settings.SMALL_GAIANET_SERVER_URL ||
                settings.MEDIUM_GAIANET_SERVER_URL ||
                settings.LARGE_GAIANET_SERVER_URL,
            apiKey: settings.GAIANET_API_KEY || runtime.token,
            dimensions: config.dimensions,
        });
    }

    if (config.provider === EmbeddingProvider.Heurist) {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint: getEndpoint(ModelProviderName.HEURIST),
            apiKey: runtime.token,
            dimensions: config.dimensions,
        });
    }

    // BGE - try local first if in Node
    if (isNode) {
        try {
            return await getLocalEmbedding(input);
        } catch (error) {
            elizaLogger.warn(
                "Local embedding failed, falling back to remote",
                error
            );
        }
    }

    // Fallback to remote override
    return await getRemoteEmbedding(input, {
        model: config.model,
        endpoint:
            runtime.character.modelEndpointOverride ||
            getEndpoint(runtime.character.modelProvider),
        apiKey: runtime.token,
        dimensions: config.dimensions,
    });

    async function getLocalEmbedding(input: string): Promise<number[]> {
        elizaLogger.debug("DEBUG - Inside getLocalEmbedding function");

        try {
            const embeddingManager = LocalEmbeddingModelManager.getInstance();
            return await embeddingManager.generateEmbedding(input);
        } catch (error) {
            elizaLogger.error("Local embedding failed:", error);
            throw error;
        }
    }

    async function retrieveCachedEmbedding(
        runtime: IAgentRuntime,
        input: string
    ) {
        if (!input) {
            elizaLogger.log("No input to retrieve cached embedding for");
            return null;
        }

        const similaritySearchResult =
            await runtime.messageManager.getCachedEmbeddings(input);
        if (similaritySearchResult.length > 0) {
            return similaritySearchResult[0].embedding;
        }
        return null;
    }
}
