import { getModelSettings, getImageModelSettings, getEndpoint, models } from "../src/models.ts";
import { ModelProviderName, ModelClass } from "../src/types.ts";
import { describe, test, expect, vi } from "vitest";

// Mock settings
vi.mock("../settings", () => {
    return {
        default: {
            SMALL_OPENROUTER_MODEL: "nousresearch/hermes-3-llama-3.1-405b",
            LARGE_OPENROUTER_MODEL: "nousresearch/hermes-3-llama-3.1-405b",
            OPENROUTER_MODEL: "mock-default-model",
            OPENAI_API_KEY: "mock-openai-key",
            ANTHROPIC_API_KEY: "mock-anthropic-key",
            OPENROUTER_API_KEY: "mock-openrouter-key",
            ETERNALAI_MODEL: "mock-eternal-model",
            ETERNALAI_URL: "https://mock.eternal.ai",
            LLAMACLOUD_MODEL_SMALL: "mock-llama-small",
            LLAMACLOUD_MODEL_LARGE: "mock-llama-large",
            TOGETHER_MODEL_SMALL: "mock-together-small",
            TOGETHER_MODEL_LARGE: "mock-together-large",
            LIVEPEER_GATEWAY_URL: "http://gateway.test-gateway",
            IMAGE_LIVEPEER_MODEL: "ByteDance/SDXL-Lightning",
        },
        loadEnv: vi.fn(),
    };
});

describe("Model Provider Configuration", () => {
    describe("OpenAI Provider", () => {
        test("should have correct endpoint", () => {
            expect(models[ModelProviderName.OPENAI].endpoint).toBe(
                "https://api.openai.com/v1"
            );
        });

        test("should have correct model mappings", () => {
            const openAIModels = models[ModelProviderName.OPENAI].model;
            expect(openAIModels[ModelClass.SMALL].name).toBe("gpt-4o-mini");
            expect(openAIModels[ModelClass.MEDIUM].name).toBe("gpt-4o");
            expect(openAIModels[ModelClass.LARGE].name).toBe("gpt-4o");
            expect(openAIModels[ModelClass.EMBEDDING].name).toBe(
                "text-embedding-3-small"
            );
            expect(openAIModels[ModelClass.IMAGE].name).toBe("dall-e-3");
        });

        test("should have correct settings configuration", () => {
            const smallModel = models[ModelProviderName.OPENAI].model[ModelClass.SMALL];
            expect(smallModel.maxInputTokens).toBe(128000);
            expect(smallModel.maxOutputTokens).toBe(8192);
            expect(smallModel.temperature).toBe(0.6);
            expect(smallModel.frequency_penalty).toBe(0.0);
            expect(smallModel.presence_penalty).toBe(0.0);
            expect(smallModel.stop).toEqual([]);
        });
    });

    describe("Anthropic Provider", () => {
        test("should have correct endpoint", () => {
            expect(models[ModelProviderName.ANTHROPIC].endpoint).toBe(
                "https://api.anthropic.com/v1"
            );
        });

        test("should have correct model mappings", () => {
            const anthropicModels = models[ModelProviderName.ANTHROPIC].model;
            expect(anthropicModels[ModelClass.SMALL].name).toBe(
                "claude-3-haiku-20240307"
            );
            expect(anthropicModels[ModelClass.MEDIUM].name).toBe(
                "claude-3-5-sonnet-20241022"
            );
            expect(anthropicModels[ModelClass.LARGE].name).toBe(
                "claude-3-5-sonnet-20241022"
            );
        });

        test("should have correct settings configuration", () => {
            const smallModel = models[ModelProviderName.ANTHROPIC].model[ModelClass.SMALL];
            expect(smallModel.maxInputTokens).toBe(200000);
            expect(smallModel.maxOutputTokens).toBe(4096);
            expect(smallModel.temperature).toBe(0.7);
            expect(smallModel.frequency_penalty).toBe(0.4);
            expect(smallModel.presence_penalty).toBe(0.4);
            expect(smallModel.stop).toEqual([]);
        });
    });

    describe("LlamaCloud Provider", () => {
        test("should have correct endpoint", () => {
            expect(models[ModelProviderName.LLAMACLOUD].endpoint).toBe(
                "https://api.llamacloud.com/v1"
            );
        });

        test("should have correct model mappings", () => {
            const llamaCloudModels = models[ModelProviderName.LLAMACLOUD].model;
            expect(llamaCloudModels[ModelClass.SMALL].name).toBe(
                "meta-llama/Llama-3.2-3B-Instruct-Turbo"
            );
            expect(llamaCloudModels[ModelClass.MEDIUM].name).toBe(
                "meta-llama-3.1-8b-instruct"
            );
            expect(llamaCloudModels[ModelClass.LARGE].name).toBe(
                "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo"
            );
        });

        test("should have correct settings configuration", () => {
            const smallModel = models[ModelProviderName.LLAMACLOUD].model[ModelClass.SMALL];
            expect(smallModel.maxInputTokens).toBe(128000);
            expect(smallModel.maxOutputTokens).toBe(8192);
            expect(smallModel.temperature).toBe(0.7);
            expect(smallModel.repetition_penalty).toBe(0.4);
        });
    });

    describe("Google Provider", () => {
        test("should have correct model mappings", () => {
            const googleModels = models[ModelProviderName.GOOGLE].model;
            expect(googleModels[ModelClass.SMALL].name).toBe("gemini-2.0-flash-exp");
            expect(googleModels[ModelClass.MEDIUM].name).toBe(
                "gemini-2.0-flash-exp"
            );
            expect(googleModels[ModelClass.LARGE].name).toBe(
                "gemini-2.0-flash-exp"
            );
        });
    });
    describe("Livepeer Provider", () => {
        test("should have correct endpoint configuration", () => {
            expect(getEndpoint(ModelProviderName.LIVEPEER)).toBe("https://dream-gateway.livepeer.cloud");
        });

        test("should have correct model mappings", () => {
            const livepeerModels = models[ModelProviderName.LIVEPEER].model;
            expect(livepeerModels[ModelClass.SMALL]?.name).toBe("meta-llama/Meta-Llama-3.1-8B-Instruct");
            expect(livepeerModels[ModelClass.MEDIUM]?.name).toBe("meta-llama/Meta-Llama-3.1-8B-Instruct");
            expect(livepeerModels[ModelClass.LARGE]?.name).toBe("meta-llama/Meta-Llama-3.1-8B-Instruct");
            expect(livepeerModels[ModelClass.IMAGE]?.name).toBe("ByteDance/SDXL-Lightning");
        });

        test("should have correct settings configuration", () => {
            const settings = getModelSettings(ModelProviderName.LIVEPEER, ModelClass.LARGE);
            expect(settings?.maxInputTokens).toBe(8000);
            expect(settings?.maxOutputTokens).toBe(8192);
            expect(settings?.temperature).toBe(0);
        });
    });
});

describe("Model Retrieval Functions", () => {
    describe("getModel function", () => {
        test("should retrieve correct models for different providers and classes", () => {
            expect(models[ModelProviderName.OPENAI].model[ModelClass.SMALL].name).toBe(
                "gpt-4o-mini"
            );
            expect(models[ModelProviderName.ANTHROPIC].model[ModelClass.MEDIUM].name).toBe(
                "claude-3-5-sonnet-20241022"
            );
        });

        test("should handle environment variable overrides", () => {
            expect(
                models[ModelProviderName.OPENROUTER].model[ModelClass.SMALL].name
            ).toBe("nousresearch/hermes-3-llama-3.1-405b");
            expect(
                models[ModelProviderName.OPENROUTER].model[ModelClass.LARGE].name
            ).toBe("nousresearch/hermes-3-llama-3.1-405b");
        });

        test("Test to ensure an invalid model provider returns undefined", () => {
            expect(
                getModelSettings("INVALID_PROVIDER" as any, ModelClass.SMALL)
            ).toBe(undefined);
        });
    });

    describe("getEndpoint function", () => {
        test("should retrieve correct endpoints for different providers", () => {
            expect(getEndpoint(ModelProviderName.OPENAI)).toBe(
                "https://api.openai.com/v1"
            );
            expect(getEndpoint(ModelProviderName.ANTHROPIC)).toBe(
                "https://api.anthropic.com/v1"
            );
            expect(getEndpoint(ModelProviderName.LLAMACLOUD)).toBe(
                "https://api.llamacloud.com/v1"
            );
        });

        test("should throw error for invalid provider", () => {
            expect(() => getEndpoint("INVALID_PROVIDER" as any)).toThrow();
        });
    });
});

describe("Model Settings Validation", () => {
    test("all providers should have required settings", () => {
        Object.values(ModelProviderName).forEach((provider) => {
            const providerConfig = models[provider];
            if (!providerConfig || !providerConfig.model) {
                return; // Skip providers that are not fully configured
            }
            const smallModel = providerConfig.model[ModelClass.SMALL];
            if (!smallModel) {
                return; // Skip if small model is not configured
            }
            expect(smallModel.maxInputTokens).toBeGreaterThan(0);
            expect(smallModel.maxOutputTokens).toBeGreaterThan(0);
            expect(smallModel.temperature).toBeDefined();
        });
    });

    test("all providers should have model mappings for basic model classes", () => {
        Object.values(ModelProviderName).forEach((provider) => {
            const providerConfig = models[provider];
            if (!providerConfig || !providerConfig.model) {
                return; // Skip providers that are not fully configured
            }
            if (providerConfig.model[ModelClass.SMALL]) {
                expect(providerConfig.model[ModelClass.SMALL].name).toBeDefined();
            }
            if (providerConfig.model[ModelClass.MEDIUM]) {
                expect(providerConfig.model[ModelClass.MEDIUM].name).toBeDefined();
            }
            if (providerConfig.model[ModelClass.LARGE]) {
                expect(providerConfig.model[ModelClass.LARGE].name).toBeDefined();
            }
        });
    });
});

describe("Environment Variable Integration", () => {
    test("should use environment variables for LlamaCloud models", () => {
        const llamaConfig = models[ModelProviderName.LLAMACLOUD];
        expect(llamaConfig.model[ModelClass.SMALL].name).toBe(
            "meta-llama/Llama-3.2-3B-Instruct-Turbo"
        );
    });

    test("should use environment variables for Together models", () => {
        const togetherConfig = models[ModelProviderName.TOGETHER];
        expect(togetherConfig.model[ModelClass.SMALL].name).toBe(
            "meta-llama/Llama-3.2-3B-Instruct-Turbo"
        );
    });
});

describe("Generation with Livepeer", () => {
    test("should have correct image generation settings", () => {
        const livepeerConfig = models[ModelProviderName.LIVEPEER];
        expect(livepeerConfig.model[ModelClass.IMAGE]?.name).toBe("ByteDance/SDXL-Lightning");
        expect(getModelSettings(ModelProviderName.LIVEPEER, ModelClass.SMALL)?.temperature).toBe(0);
    });

    test("should use default image model", () => {
        process.env.IMAGE_LIVEPEER_MODEL = undefined;
        expect(getImageModelSettings(ModelProviderName.LIVEPEER)?.name).toBe("ByteDance/SDXL-Lightning");
    });
});
