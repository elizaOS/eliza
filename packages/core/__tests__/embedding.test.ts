import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  embed,
  getEmbeddingConfig,
  getEmbeddingType,
  getEmbeddingZeroVector,
} from "../src/embedding.ts"
import settings from "../src/settings.ts";
import { type IAgentRuntime, ModelProviderName } from "../src/types.ts";

// Mock environment-related settings
vi.mock("../settings", () => ({
    default: {
        USE_OPENAI_EMBEDDING: "false",
        USE_OLLAMA_EMBEDDING: "false",
        USE_GAIANET_EMBEDDING: "false",
        USE_CUSTOM_EMBEDDING: "false",
        CUSTOM_EMBEDDING_DIMENSIONS: "768",
        CUSTOM_EMBEDDING_MODEL: "custom-model",
        CUSTOM_EMBEDDING_ENDPOINT: "https://custom-api.example.com",
        CUSTOM_EMBEDDING_API_KEY: "custom-api-key",
        OPENAI_API_KEY: "mock-openai-key",
        OPENAI_API_URL: "https://api.openai.com/v1",
        GAIANET_API_KEY: "mock-gaianet-key",
        OLLAMA_EMBEDDING_MODEL: "mxbai-embed-large",
        GAIANET_EMBEDDING_MODEL: "nomic-embed",
    },
}));

// Mock fastembed module for local embeddings
vi.mock("fastembed", () => ({
    FlagEmbedding: {
        init: vi.fn().mockResolvedValue({
            queryEmbed: vi
                .fn()
                .mockResolvedValue(new Float32Array(384).fill(0.1)),
        }),
    },
    EmbeddingModel: {
        BGESmallENV15: "BGE-small-en-v1.5",
    },
}));

// Mock global fetch for remote embedding requests
const mockFetch = vi.fn();
(global as any).fetch = mockFetch;

describe("Embedding Module", () => {
    let mockRuntime: IAgentRuntime;

    beforeEach(() => {
        // Prepare a mock runtime
        mockRuntime = {
            character: {
                modelProvider: ModelProviderName.OLLAMA,
                modelEndpointOverride: null,
            },
            token: "mock-token",
            messageManager: {
                getCachedEmbeddings: vi.fn().mockResolvedValue([]),
            },
        } as unknown as IAgentRuntime;

        vi.clearAllMocks();
        mockFetch.mockReset();
    });

    describe("getEmbeddingConfig", () => {
        test("should return BGE config by default", () => {
            const config = getEmbeddingConfig();
            expect(config.dimensions).toBe(384);
            expect(config.model).toBe("BGE-small-en-v1.5");
            expect(config.provider).toBe("BGE");
        });

        test("should return OpenAI config when USE_OPENAI_EMBEDDING is true", () => {
            vi.mocked(settings).USE_OPENAI_EMBEDDING = "true";
            const config = getEmbeddingConfig();
            expect(config.dimensions).toBe(1536);
            expect(config.model).toBe("text-embedding-3-small");
            expect(config.provider).toBe("OpenAI");
        });

        test("should return Custom config when USE_CUSTOM_EMBEDDING is true", () => {
            vi.mocked(settings).USE_CUSTOM_EMBEDDING = "true";
            // ensure required custom settings exist for this test
            vi.mocked(settings).CUSTOM_EMBEDDING_DIMENSIONS = "768";
            vi.mocked(settings).CUSTOM_EMBEDDING_MODEL = "custom-model";
            vi.mocked(settings).CUSTOM_EMBEDDING_ENDPOINT = "https://custom-api.example.com";
            vi.mocked(settings).CUSTOM_EMBEDDING_API_KEY = "custom-api-key";
            const config = getEmbeddingConfig();
            expect(config.dimensions).toBe(768);
            expect(config.model).toBe("custom-model");
            expect(config.provider).toBe("Custom");
        });

        test("should throw error when custom embedding is enabled but settings are missing", () => {
            // Use process.env to simulate missing custom settings for this test.
            const prevUse = process.env.USE_CUSTOM_EMBEDDING;
            const prevDim = process.env.CUSTOM_EMBEDDING_DIMENSIONS;
            const prevModel = process.env.CUSTOM_EMBEDDING_MODEL;
            const prevEndpoint = process.env.CUSTOM_EMBEDDING_ENDPOINT;
            const prevApiKey = process.env.CUSTOM_EMBEDDING_API_KEY;
            try {
                process.env.USE_CUSTOM_EMBEDDING = "true";
                delete process.env.CUSTOM_EMBEDDING_DIMENSIONS;
                delete process.env.CUSTOM_EMBEDDING_MODEL;
                delete process.env.CUSTOM_EMBEDDING_ENDPOINT;
                delete process.env.CUSTOM_EMBEDDING_API_KEY;

                expect(() => getEmbeddingConfig()).toThrow(
                    "Custom embedding enabled but missing required settings"
                );
            } finally {
                // restore environment
                if (prevUse === undefined) delete process.env.USE_CUSTOM_EMBEDDING; else process.env.USE_CUSTOM_EMBEDDING = prevUse;
                if (prevDim === undefined) delete process.env.CUSTOM_EMBEDDING_DIMENSIONS; else process.env.CUSTOM_EMBEDDING_DIMENSIONS = prevDim;
                if (prevModel === undefined) delete process.env.CUSTOM_EMBEDDING_MODEL; else process.env.CUSTOM_EMBEDDING_MODEL = prevModel;
                if (prevEndpoint === undefined) delete process.env.CUSTOM_EMBEDDING_ENDPOINT; else process.env.CUSTOM_EMBEDDING_ENDPOINT = prevEndpoint;
                if (prevApiKey === undefined) delete process.env.CUSTOM_EMBEDDING_API_KEY; else process.env.CUSTOM_EMBEDDING_API_KEY = prevApiKey;
            }
        });
    });

    describe("getEmbeddingType", () => {
        test("should return 'remote' for Ollama provider", () => {
            const type = getEmbeddingType(mockRuntime);
            expect(type).toBe("remote");
        });

        test("should return 'remote' for OpenAI provider", () => {
            mockRuntime.character.modelProvider = ModelProviderName.OPENAI;
            const type = getEmbeddingType(mockRuntime);
            expect(type).toBe("remote");
        });
    });

    describe("getEmbeddingZeroVector", () => {
        beforeEach(() => {
            vi.mocked(settings).USE_OPENAI_EMBEDDING = "false";
            vi.mocked(settings).USE_OLLAMA_EMBEDDING = "false";
            vi.mocked(settings).USE_GAIANET_EMBEDDING = "false";
        });

        test("should return 384-length zero vector by default (BGE)", () => {
            const vector = getEmbeddingZeroVector();
            expect(vector).toHaveLength(384);
            expect(vector.every((val) => val === 0)).toBe(true);
        });

        test("should return 1536-length zero vector for OpenAI if enabled", () => {
            vi.mocked(settings).USE_OPENAI_EMBEDDING = "true";
            const vector = getEmbeddingZeroVector();
            expect(vector).toHaveLength(1536);
            expect(vector.every((val) => val === 0)).toBe(true);
        });
    });

    describe("embed function", () => {
        beforeEach(() => {
            // Mock a successful remote response with an example 384-dim embedding
            mockFetch.mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({
                        data: [{ embedding: new Array(384).fill(0.1) }],
                    }),
            });
        });

        test("should return an empty array for empty input text", async () => {
            const result = await embed(mockRuntime, "");
            expect(result).toEqual([]);
        });

        test("should return cached embedding if it already exists", async () => {
            const cachedEmbedding = new Array(384).fill(0.5);
            mockRuntime.messageManager.getCachedEmbeddings = vi
                .fn()
                .mockResolvedValue([{ embedding: cachedEmbedding }]);

            const result = await embed(mockRuntime, "test input");
            expect(result).toBe(cachedEmbedding);
        });

        test("should handle local embedding successfully (fastembed fallback)", async () => {
            // By default, it tries local first if in Node.
            // Then uses the mock fastembed response above.
            const result = await embed(mockRuntime, "test input");
            expect(result).toHaveLength(384);
            expect(result.every((v) => typeof v === "number")).toBe(true);
        });

        test("should fallback to remote if local embedding fails", async () => {
            // Force fastembed import to fail
            vi.mock("fastembed", () => {
                throw new Error("Module not found");
            });

            // Mock a valid remote response
            const mockResponse = {
                ok: true,
                json: () =>
                    Promise.resolve({
                        data: [{ embedding: new Array(384).fill(0.1) }],
                    }),
            };
            mockFetch.mockResolvedValueOnce(mockResponse);

            const result = await embed(mockRuntime, "test input");
            expect(result).toHaveLength(384);
            expect(mockFetch).toHaveBeenCalled();
        });

        test("should throw on remote embedding if fetch fails", async () => {
            mockFetch.mockRejectedValueOnce(new Error("API Error"));
            vi.mocked(settings).USE_OPENAI_EMBEDDING = "true"; // Force remote

            await expect(embed(mockRuntime, "test input")).rejects.toThrow(
                "API Error"
            );
        });

        test("should throw on non-200 remote response", async () => {
            const errorResponse = {
                ok: false,
                status: 400,
                statusText: "Bad Request",
                text: () => Promise.resolve("Invalid input"),
            };
            mockFetch.mockResolvedValueOnce(errorResponse);
            vi.mocked(settings).USE_OPENAI_EMBEDDING = "true"; // Force remote

            await expect(embed(mockRuntime, "test input")).rejects.toThrow(
                "Embedding API Error"
            );
        });

        test("should handle concurrent embedding requests", async () => {
            const promises = Array(5)
                .fill(null)
                .map(() => embed(mockRuntime, "concurrent test"));
            await expect(Promise.all(promises)).resolves.toBeDefined();
        });

        test("should use custom embedding provider when enabled", async () => {
            vi.mocked(settings).USE_CUSTOM_EMBEDDING = "true";
            // ensure required custom settings exist for this test
            vi.mocked(settings).CUSTOM_EMBEDDING_DIMENSIONS = "768";
            vi.mocked(settings).CUSTOM_EMBEDDING_MODEL = "custom-model";
            vi.mocked(settings).CUSTOM_EMBEDDING_ENDPOINT = "https://custom-api.example.com";
            vi.mocked(settings).CUSTOM_EMBEDDING_API_KEY = "custom-api-key";
            const customDimensions = 768;
            const mockCustomEmbedding = new Array(customDimensions).fill(0.2);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    data: [{ embedding: mockCustomEmbedding }]
                    }),
            });
            const result = await embed(mockRuntime, "test input");
            expect(result).toHaveLength(customDimensions);
            expect(mockFetch).toHaveBeenCalledWith(
                "https://custom-api.example.com/embeddings",
                expect.objectContaining({
                    method: "POST",
                    headers: expect.objectContaining({
                        "Authorization": "Bearer custom-api-key"
                    }),
                    body: expect.stringContaining("custom-model"),
                })
            );
        });

        test("should handle custom embedding API errors gracefully", async () => {
            vi.mocked(settings).USE_CUSTOM_EMBEDDING = "true";
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: "Internal Server Error",
                text: () => Promise.resolve("Custom API Error"),
            });
            await expect(embed(mockRuntime, "test input")).rejects.toThrow("Embedding API Error");
        });
    });
});
