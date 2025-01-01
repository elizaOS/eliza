import path from "node:path";
import { models } from "./models.ts";
import { IAgentRuntime, Memory, ModelProviderName } from "./types.ts";
import settings from "./settings.ts";
import elizaLogger from "./logger.ts";

interface EmbeddingOptions {
    model: string;
    endpoint: string;
    apiKey?: string;
    length?: number;
    isOllama?: boolean;
    dimensions?: number;
    provider?: string;
}

// Add the embedding configuration
export const getEmbeddingConfig = () => ({
    dimensions:
        settings.USE_LLAMACLOUD_EMBEDDING?.toLowerCase() === "true"
            ? 768 // LlamaCloud
            : settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
              ? 1536 // OpenAI
              : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                ? 1024 // Ollama mxbai-embed-large
                : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                  ? 768 // GaiaNet
                  : 384, // BGE

    model:
        settings.USE_LLAMACLOUD_EMBEDDING?.toLowerCase() === "true"
            ? "togethercomputer/m2-bert-80M-32k-retrieval"
            : settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
              ? "text-embedding-3-small"
              : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                ? settings.OLLAMA_EMBEDDING_MODEL || "mxbai-embed-large"
                : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                  ? settings.GAIANET_EMBEDDING_MODEL || "nomic-embed"
                  : "BGE-small-en-v1.5",
    provider:
        settings.USE_LLAMACLOUD_EMBEDDING?.toLowerCase() === "true"
            ? "LlamaCloud"
            : settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
              ? "OpenAI"
              : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                ? "Ollama"
                : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                  ? "GaiaNet"
                  : "BGE",
});

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
            // dimensions:
            //     options.dimensions ||
            //     options.length ||
            //     getEmbeddingConfig().dimensions, // Prefer dimensions, fallback to length
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
        runtime.character.modelProvider !== ModelProviderName.LLAMACLOUD &&
        runtime.character.modelProvider !== ModelProviderName.OPENAI &&
        runtime.character.modelProvider !== ModelProviderName.GAIANET &&
        !settings.USE_OPENAI_EMBEDDING;

    return isLocal ? "local" : "remote";
}

export function getEmbeddingZeroVector(): number[] {
    let embeddingDimension = 384; // Default BGE dimension

    if (settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = 1536; // OpenAI dimension
    } else if (settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = 1024; // Ollama mxbai-embed-large dimension
    } else if (settings.USE_LLAMACLOUD_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = 768; // LlamaCloud dimension
    }

    return Array(embeddingDimension).fill(0);
}

/**
 * Gets embeddings from a remote API endpoint.  Falls back to local BGE/384
 *
 * @param {string} input - The text to generate embeddings for
 * @param {EmbeddingOptions} options - Configuration options including:
 *   - model: The model name to use
 *   - endpoint: Base API endpoint URL
 *   - apiKey: Optional API key for authentication
 *   - isOllama: Whether this is an Ollama endpoint
 *   - dimensions: Desired embedding dimensions
 * @param {IAgentRuntime} runtime - The agent runtime context
 * @returns {Promise<number[]>} Array of embedding values
 * @throws {Error} If the API request fails
 */

export async function embed(runtime: IAgentRuntime, input: string) {
    elizaLogger.debug("Embedding request:", {
        modelProvider: runtime.character.modelProvider,
        useOpenAI: process.env.USE_OPENAI_EMBEDDING,
        useLlamacloud: process.env.USE_LLAMACLOUD_EMBEDDING,
        input: input?.slice(0, 50) + "...",
        inputType: typeof input,
        inputLength: input?.length,
        isString: typeof input === "string",
        isEmpty: !input,
    });

    // Validate input
    if (!input || typeof input !== "string" || input.trim().length === 0) {
        elizaLogger.warn("Invalid embedding input:", {
            input,
            type: typeof input,
            length: input?.length,
        });
        return []; // Return empty embedding array
    }

    // Check cache first
    const cachedEmbedding = await retrieveCachedEmbedding(runtime, input);
    if (cachedEmbedding) return cachedEmbedding;

    const config = getEmbeddingConfig();
    const isNode = typeof process !== "undefined" && process.versions?.node;

    if (config.provider === "LlamaCloud") {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint: "https://api.together.ai/v1",
            apiKey: settings.TOGETHER_API_KEY,
            // dimensions: config.dimensions,
        });
    }

    // Determine which embedding path to use
    if (config.provider === "OpenAI") {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint: "https://api.openai.com/v1",
            apiKey: settings.OPENAI_API_KEY,
            dimensions: config.dimensions,
        });
    }

    if (config.provider === "Ollama") {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint:
                runtime.character.modelEndpointOverride ||
                models[ModelProviderName.OLLAMA].endpoint,
            isOllama: true,
            dimensions: config.dimensions,
        });
    }

    if (config.provider == "GaiaNet") {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint:
                runtime.character.modelEndpointOverride ||
                models[ModelProviderName.GAIANET].endpoint ||
                settings.SMALL_GAIANET_SERVER_URL ||
                settings.MEDIUM_GAIANET_SERVER_URL ||
                settings.LARGE_GAIANET_SERVER_URL,
            apiKey: settings.GAIANET_API_KEY || runtime.token,
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
            models[runtime.character.modelProvider].endpoint,
        apiKey: runtime.token,
        dimensions: config.dimensions,
    });

    async function getLocalEmbedding(input: string): Promise<number[]> {
        elizaLogger.debug("DEBUG - Inside getLocalEmbedding function");

        // Check if we're in Node.js environment
        const isNode =
            typeof process !== "undefined" &&
            process.versions != null &&
            process.versions.node != null;

        if (!isNode) {
            elizaLogger.warn(
                "Local embedding not supported in browser, falling back to remote embedding"
            );
            throw new Error("Local embedding not supported in browser");
        }

        try {
            const moduleImports = await Promise.all([
                import("fs"),
                import("url"),
                (async () => {
                    try {
                        return await import("fastembed");
                    } catch {
                        elizaLogger.error("Failed to load fastembed.");
                        throw new Error(
                            "fastembed import failed, falling back to remote embedding"
                        );
                    }
                })(),
            ]);

            const [fs, { fileURLToPath }, fastEmbed] = moduleImports;
            const { FlagEmbedding, EmbeddingModel } = fastEmbed;

            function getRootPath() {
                const __filename = fileURLToPath(import.meta.url);
                const __dirname = path.dirname(__filename);

                const rootPath = path.resolve(__dirname, "..");
                if (rootPath.includes("/eliza/")) {
                    return rootPath.split("/eliza/")[0] + "/eliza/";
                }

                return path.resolve(__dirname, "..");
            }

            const cacheDir = getRootPath() + "/cache/";

            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            elizaLogger.debug("Initializing BGE embedding model...");

            const embeddingModel = await FlagEmbedding.init({
                cacheDir: cacheDir,
                model: EmbeddingModel.BGESmallENV15,
                // BGE-small-en-v1.5 specific settings
                maxLength: 512, // BGE's context window
            });

            elizaLogger.debug("Generating embedding for input:", {
                inputLength: input.length,
                inputPreview: input.slice(0, 100) + "...",
            });

            // Let fastembed handle tokenization internally
            const embedding = await embeddingModel.queryEmbed(input);

            // Debug the raw embedding
            elizaLogger.debug("Raw embedding from BGE:", {
                type: typeof embedding,
                isArray: Array.isArray(embedding),
                dimensions: Array.isArray(embedding)
                    ? embedding.length
                    : "not an array",
                sample: Array.isArray(embedding)
                    ? embedding.slice(0, 5)
                    : embedding,
            });

            // Process the embedding into the correct format
            let finalEmbedding: number[];

            if (
                ArrayBuffer.isView(embedding) &&
                embedding.constructor === Float32Array
            ) {
                // Direct Float32Array result
                finalEmbedding = Array.from(embedding);
            } else if (
                Array.isArray(embedding) &&
                ArrayBuffer.isView(embedding[0]) &&
                embedding[0].constructor === Float32Array
            ) {
                // Nested Float32Array result
                finalEmbedding = Array.from(embedding[0]);
            } else if (Array.isArray(embedding)) {
                // Direct array result
                finalEmbedding = embedding;
            } else {
                throw new Error(
                    `Unexpected embedding format: ${typeof embedding}`
                );
            }

            elizaLogger.debug("Processed embedding:", {
                length: finalEmbedding.length,
                sample: finalEmbedding.slice(0, 5),
                allNumbers: finalEmbedding.every((n) => typeof n === "number"),
            });

            // Ensure all values are proper numbers
            finalEmbedding = finalEmbedding.map((n) => Number(n));

            // Validate the final embedding
            if (
                !Array.isArray(finalEmbedding) ||
                finalEmbedding[0] === undefined
            ) {
                throw new Error(
                    "Invalid embedding format: must be an array starting with a number"
                );
            }

            // Validate embedding dimensions (should be 384 for BGE-small)
            if (finalEmbedding.length !== 384) {
                elizaLogger.warn(
                    `Unexpected embedding dimension: ${finalEmbedding.length} (expected 384)`
                );
            }

            return finalEmbedding;
        } catch {
            // Browser implementation - fallback to remote embedding
            elizaLogger.warn(
                "Local embedding not supported in browser, falling back to remote embedding"
            );
            throw new Error("Local embedding not supported in browser");
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

interface MemoryMetrics {
    similarity: number;
    timeScore: number;
    importanceScore: number;
    semanticDiversity: number;
}

interface ExtendedMemory extends Memory {
    reactions?: string[];
    replies?: Memory[];
    references?: string[];
    userReputation?: number;
    isAnnouncement?: boolean;
    isPinned?: boolean;
}

export async function getRelevantContext(
    runtime: IAgentRuntime,
    memory: Memory,
    tableName: string
): Promise<Memory[]> {
    const embeddings = await embed(runtime, memory.content.text);

    const memories = await runtime.databaseAdapter.searchMemories({
        tableName: "messages",
        roomId: memory.roomId,
        agentId: runtime.agentId,
        embedding: embeddings,
        match_threshold: 0.5,
        match_count: 20,
        unique: true,
    });

    if (!memories.length) {
        elizaLogger.info("No relevant memories found");
        return [];
    }

    // Calculate semantic clusters for diversity scoring
    const memoryEmbeddings = await Promise.all(
        memories.map(mem => embed(runtime, mem.content.text))
    );
    const semanticClusters = calculateSemanticClusters(memoryEmbeddings);

    // Process and score the memories
    const processedMemories = memories
        .filter((memory): memory is Required<Memory> => {
            const isValid =
                memory?.id &&
                memory?.content &&
                typeof memory.content === 'object' &&
                'text' in memory.content &&
                typeof memory.content.text === 'string';

            if (!isValid) {
                elizaLogger.warn("Invalid memory structure:", { memory });
            }
            return isValid;
        })
        .map((memory, index) => {
            const importanceScore = calculateImportanceScore(memory);
            const timeScore = calculateTimeDecay(memory.createdAt || Date.now());
            const semanticDiversity = calculateSemanticDiversity(
                index,
                semanticClusters
            );

            const score = (
                (memory.similarity || 0) * 0.35 +
                timeScore * 0.25 +
                importanceScore * 0.25 +
                semanticDiversity * 0.15
            );

            return {
                ...memory,
                score,
                metrics: {
                    similarity: memory.similarity || 0,
                    timeScore,
                    importanceScore,
                    semanticDiversity
                } as MemoryMetrics
            };
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .filter(ensureDiverseMemories)
        .slice(0, 5);

    elizaLogger.debug("Processed memories:", {
        finalCount: processedMemories.length,
        sample: processedMemories.slice(0, 2).map(m => ({
            id: m.id,
            text: m.content.text,
            score: m.score,
            metrics: m.metrics
        })),
    });

    return processedMemories;
}

function calculateTimeDecay(timestamp: number): number {
    const hoursSince = (Date.now() - timestamp) / (1000 * 60 * 60);
    return 1 / (1 + Math.log(1 + hoursSince));
}

function calculateImportanceScore(memory: Memory): number {
    const content = memory.content;

    const factors = {
        // Content quality factors
        contentLength: Math.min(content.text.length / 500, 1) * 0.2,
        hasLinks: content.url ? 0.15 : 0,
        hasAttachments: (content.attachments?.length || 0) > 0 ? 0.15 : 0,
        isReply: content.inReplyTo ? 0.1 : 0,
        hasAction: content.action ? 0.15 : 0,

        // Thread depth (if part of conversation)
        threadDepth: content.inReplyTo ?
            calculateThreadDepth(memory as ExtendedMemory) * 0.1 : 0,

        // Time relevance (more recent = more important)
        timeRelevance: memory.createdAt ?
            Math.min((Date.now() - memory.createdAt) / (24 * 60 * 60 * 1000), 1) * 0.15 : 0,

        // Embedding quality
        embeddingQuality: memory.embedding ?
            Math.min(memory.embedding.length / 1000, 1) * 0.1 : 0
    };

    return Math.min(
        Object.values(factors).reduce((sum, score) => sum + score, 0),
        1
    );
}

function calculateThreadDepth(memory: ExtendedMemory, depth = 0): number {
    if (!memory.content.inReplyTo || depth > 5) {
        return depth;
    }

    const parentMemory = memory.replies?.find(m => m.id === memory.content.inReplyTo);
    if (!parentMemory) {
        return depth;
    }

    return calculateThreadDepth(parentMemory as ExtendedMemory, depth + 1);
}

function calculateSemanticClusters(embeddings: number[][]): number[][][] {
    const k = Math.min(5, Math.floor(embeddings.length / 2));
    const clusters: number[][][] = [];

    for (let i = 0; i < k; i++) {
        clusters.push([embeddings[i]]);
    }

    embeddings.slice(k).forEach(embedding => {
        let minDistance = Infinity;
        let nearestCluster = 0;

        clusters.forEach((cluster, index) => {
            const centroid = cluster[0];  // Use first embedding as centroid
            const distance = cosineSimilarity(embedding, centroid);
            if (distance < minDistance) {
                minDistance = distance;
                nearestCluster = index;
            }
        });

        clusters[nearestCluster].push(embedding);
    });

    return clusters;
}

function calculateSemanticDiversity(
    index: number,
    clusters: number[][][]
): number {
    if (index === 0) return 1;

    const clusterIndex = clusters.findIndex(cluster =>
        cluster.some(embedding => embedding.includes(index))
    );

    const previousClusters = new Set();
    for (let i = 0; i < index; i++) {
        clusters.forEach((cluster, idx) => {
            if (cluster.some(embedding => embedding.includes(i))) {
                previousClusters.add(idx);
            }
        });
    }

    return 1 - (previousClusters.has(clusterIndex) ? 0.5 : 0);
}

function ensureDiverseMemories(
    memory: Memory & { metrics: MemoryMetrics },
    index: number,
    array: (Memory & { metrics: MemoryMetrics })[]
): boolean {
    if (index === 0) return true;

    const previousMemories = array.slice(0, index);

    // Check multiple diversity criteria
    return !previousMemories.some(prev => {
        const isTooSimilar = memory.metrics.similarity > 0.95;
        const isCloseinTime = Math.abs(memory.createdAt - prev.createdAt) < 3600000;
        const hasSimilarImportance = Math.abs(
            memory.metrics.importanceScore - prev.metrics.importanceScore
        ) < 0.2;
        const lowSemanticDiversity = memory.metrics.semanticDiversity < 0.3;

        return (isTooSimilar && isCloseinTime) ||
               (hasSimilarImportance && lowSemanticDiversity);
    });
}

function cosineSimilarity(a: number[], b: number[]): number {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}
