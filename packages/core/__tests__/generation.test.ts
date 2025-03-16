import { describe, beforeEach, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import * as ai from "ai";
import { generateObject, generateText } from "../src/generation";
import { ModelClass, ModelProviderName, ServiceType } from "../src/types";
import { AgentRuntime } from "../src/runtime";
import { Message } from "ai";

// Mock the ai-sdk modules
vi.mock("@ai-sdk/openai", () => ({
    createOpenAI: vi.fn(() => ({
        languageModel: vi.fn(() => "mocked-openai-model"),
    })),
    openai: vi.fn(() => ({
        languageModel: vi.fn(() => "mocked-openai-model"),
    })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
    createAnthropic: vi.fn(() => ({
        languageModel: vi.fn(() => "mocked-anthropic-model"),
    })),
    anthropic: vi.fn(() => ({
        languageModel: vi.fn(() => "mocked-anthropic-model"),
    })),
}));

// Mock the ai module
vi.mock("ai", () => ({
    generateObject: vi.fn().mockResolvedValue({
        text: "mocked response",
        response: { foo: "bar" },
    }),
    generateText: vi.fn().mockResolvedValue({
        text: "mocked text response",
    }),
}));

// Mock js-tiktoken to avoid issues with trimTokens
vi.mock("js-tiktoken", () => ({
    encodingForModel: vi.fn().mockReturnValue({
        encode: vi.fn().mockReturnValue([]),
        decode: vi.fn().mockReturnValue(""),
    }),
}));

// Mock generateObjectDeprecated at the top level
vi.mock("../src/generation", async () => {
    const actual = await vi.importActual("../src/generation");
    return {
        ...(actual as object),
        generateObjectDeprecated: vi.fn().mockResolvedValue({ foo: "bar" }),
        trimTokens: vi.fn().mockImplementation((text) => Promise.resolve(text)),
    };
});

describe("Generation Module", () => {
    let runtime: AgentRuntime;

    beforeEach(() => {
        // Create a mock runtime
        runtime = {
            modelProvider: ModelProviderName.OPENAI,
            token: "mock-api-key",
            character: {
                system: "You are a helpful assistant",
                settings: {
                    modelConfig: {
                        temperature: 0.7,
                        frequency_penalty: 0,
                        presence_penalty: 0,
                    },
                },
            },
            getSetting: vi.fn((key) => {
                const settings = {
                    TOKENIZER_MODEL: "gpt-4o",
                    TOKENIZER_TYPE: "tiktoken",
                    CLOUDFLARE_GW_ENABLED: "false",
                };
                return settings[key];
            }),
            fetch: vi.fn().mockImplementation(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            choices: [
                                { message: { content: "mocked response" } },
                            ],
                        }),
                    clone: () => ({
                        json: () =>
                            Promise.resolve({
                                choices: [
                                    { message: { content: "mocked response" } },
                                ],
                            }),
                    }),
                })
            ),
            getService: vi.fn().mockImplementation((serviceType) => {
                if (serviceType === ServiceType.TEXT_GENERATION) {
                    return {
                        queueTextCompletion: vi
                            .fn()
                            .mockResolvedValue(
                                '<response>{"foo": "local response"}</response>'
                            ),
                    };
                }
                return null;
            }),
        } as unknown as AgentRuntime;

        // Reset all mocks before each test
        vi.clearAllMocks();
    });

    afterEach(() => {
        // vi.resetAllMocks();
    });

    describe("generateObject", () => {
        const testSchema = z.object({
            name: z.string(),
            age: z.number(),
        });

        it("should generate an object using OpenAI provider", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.OPENAI;

            // Execute
            const result = await generateObject({
                runtime,
                context: "Generate a person object",
                modelClass: ModelClass.LARGE,
                schema: testSchema,
                schemaName: "Person",
                schemaDescription: "A person with name and age",
            });

            // Verify
            expect(ai.generateObject).toHaveBeenCalled();
            expect(result).toEqual({
                text: "mocked response",
                response: { foo: "bar" },
            });
        });

        it("should generate an object using Anthropic provider", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.ANTHROPIC;

            // Execute
            const result = await generateObject({
                runtime,
                context: "Generate a person object",
                modelClass: ModelClass.LARGE,
                schema: testSchema,
            });

            // Verify
            expect(ai.generateObject).toHaveBeenCalled();
            expect(result).toEqual({
                text: "mocked response",
                response: { foo: "bar" },
            });
        });

        it("should throw an error for empty context", async () => {
            // Execute & Verify
            await expect(
                generateObject({
                    runtime,
                    context: "",
                    modelClass: ModelClass.LARGE,
                    schema: testSchema,
                })
            ).rejects.toThrow("generateObject context is empty");
        });

        it("should throw an error for unsupported provider", async () => {
            // Setup
            runtime.modelProvider = "UNSUPPORTED_PROVIDER" as ModelProviderName;

            // Execute & Verify
            await expect(
                generateObject({
                    runtime,
                    context: "Generate a person object",
                    modelClass: ModelClass.LARGE,
                    schema: testSchema,
                })
            ).rejects.toThrow(
                "Model settings not found for provider: UNSUPPORTED_PROVIDER"
            );
        });
    });

    describe("generateText", () => {
        it("should generate text using OpenAI provider", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.OPENAI;

            // Execute
            const result = await generateText({
                runtime,
                context: "Generate a response",
                modelClass: ModelClass.LARGE,
            });

            // Verify
            expect(ai.generateText).toHaveBeenCalled();
            expect(result).toBe("mocked text response");
        });

        it("should generate text using Anthropic provider", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.ANTHROPIC;

            // Execute
            const result = await generateText({
                runtime,
                context: "Generate a response",
                modelClass: ModelClass.LARGE,
            });

            // Verify
            expect(ai.generateText).toHaveBeenCalled();
            expect(result).toBe("mocked text response");
        });

        it("should generate text using LlamaLocal provider", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.LLAMALOCAL;

            // Execute
            const result = await generateText({
                runtime,
                context: "Generate a response",
                modelClass: ModelClass.LARGE,
            });

            // Verify
            expect(runtime.getService).toHaveBeenCalledWith(
                ServiceType.TEXT_GENERATION
            );
            expect(result).toBe(
                '<response>{"foo": "local response"}</response>'
            );
        });

        it("should handle empty context", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.OPENAI;

            // Execute
            const result = await generateText({
                runtime,
                context: "",
                modelClass: ModelClass.LARGE,
            });

            // Verify
            expect(result).toBe("");
        });

        it("should throw an error for unsupported provider", async () => {
            // Setup
            runtime.modelProvider = "UNSUPPORTED_PROVIDER" as ModelProviderName;

            // Execute & Verify
            await expect(
                generateText({
                    runtime,
                    context: "Generate a response",
                    modelClass: ModelClass.LARGE,
                })
            ).rejects.toThrow(
                "Cannot read properties of undefined (reading 'endpoint')"
            );
        });

        it("should support custom system prompt", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.OPENAI;
            const customSystemPrompt = "You are a helpful coding assistant";

            // Execute
            await generateText({
                runtime,
                context: "Generate a response",
                modelClass: ModelClass.LARGE,
                customSystemPrompt,
            });

            // Verify
            expect(ai.generateText).toHaveBeenCalledWith(
                expect.objectContaining({
                    system: customSystemPrompt,
                })
            );
        });

        it("should support tools and maxSteps", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.OPENAI;
            const tools = {
                search: {
                    description: "Search for information",
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "The search query",
                            },
                        },
                        required: ["query"],
                    },
                },
            };
            const maxSteps = 3;
            const onStepFinish = vi.fn();

            // Execute
            await generateText({
                runtime,
                context: "Generate a response",
                modelClass: ModelClass.LARGE,
                tools,
                maxSteps,
                onStepFinish,
            });

            // Verify
            expect(ai.generateText).toHaveBeenCalledWith(
                expect.objectContaining({
                    tools,
                    maxSteps,
                    onStepFinish,
                })
            );
        });

        it.skip("should support stop sequences", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.OPENAI;
            const stop = ["END", "STOP"];

            // Execute
            await generateText({
                runtime,
                context: "Generate a response",
                modelClass: ModelClass.LARGE,
                stop,
            });

            // Verify
            expect(ai.generateText).toHaveBeenCalledWith(
                expect.objectContaining({
                    stop,
                })
            );
        });

        it("should support messages parameter", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.ANTHROPIC;
            const messages: Message[] = [
                { id: "1", role: "user", content: "Hello" },
                { id: "2", role: "assistant", content: "Hi there" },
            ];

            // Execute
            await generateText({
                runtime,
                context: "Generate a response",
                modelClass: ModelClass.LARGE,
                messages,
            });

            // Verify
            expect(ai.generateText).toHaveBeenCalledWith(
                expect.objectContaining({
                    messages,
                })
            );
        });

        it("should use Cloudflare Gateway when enabled", async () => {
            // Setup
            runtime.modelProvider = ModelProviderName.OPENAI;
            runtime.getSetting = vi.fn((key) => {
                const settings = {
                    TOKENIZER_MODEL: "gpt-4o",
                    TOKENIZER_TYPE: "tiktoken",
                    CLOUDFLARE_GW_ENABLED: "true",
                    CLOUDFLARE_AI_ACCOUNT_ID: "mock-account-id",
                    CLOUDFLARE_AI_GATEWAY_ID: "mock-gateway-id",
                };
                return settings[key];
            });

            // Execute
            await generateText({
                runtime,
                context: "Generate a response",
                modelClass: ModelClass.LARGE,
            });
        });
    });
});
