import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv, validateCharacterConfig } from "../src/environment";
import { ModelProviderName } from "../src/types";

describe("Environment Configuration", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            OPENAI_API_KEY: "sk-test123",
            REDPILL_API_KEY: "test-key",
            GROK_API_KEY: "test-key",
            GROQ_API_KEY: "gsk_test123",
            OPENROUTER_API_KEY: "test-key",
            GOOGLE_GENERATIVE_AI_API_KEY: "test-key",
            ELEVENLABS_XI_API_KEY: "test-key",
        };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("should validate correct environment variables", () => {
        expect(() => validateEnv()).not.toThrow();
    });

    it("should throw error for invalid OpenAI API key format", () => {
        process.env.OPENAI_API_KEY = "invalid-key";
        expect(() => validateEnv()).toThrow(
            "OpenAI API key must start with 'sk-'"
        );
    });

    it("should throw error for invalid GROQ API key format", () => {
        process.env.GROQ_API_KEY = "invalid-key";
        expect(() => validateEnv()).toThrow(
            "GROQ API key must start with 'gsk_'"
        );
    });

    it("should throw error for missing required keys", () => {
        process.env.REDPILL_API_KEY = undefined;
        expect(() => validateEnv()).toThrow("REDPILL_API_KEY: Required");
    });

    it("should throw error for multiple missing required keys", () => {
        process.env.REDPILL_API_KEY = undefined;
        process.env.GROK_API_KEY = undefined;
        process.env.OPENROUTER_API_KEY = undefined;
        expect(() => validateEnv()).toThrow(
            "Environment validation failed:\n" +
                "REDPILL_API_KEY: Required\n" +
                "GROK_API_KEY: Required\n" +
                "OPENROUTER_API_KEY: Required"
        );
    });
});

describe("Character Configuration", () => {
    const validCharacterConfig = {
        name: "Test Character",
        modelProvider: ModelProviderName.OPENAI,
        bio: "Test bio",
        lore: ["Test lore"],
        messageExamples: [
            [
                {
                    user: "user1",
                    content: {
                        text: "Hello",
                    },
                },
            ],
        ],
        postExamples: ["Test post"],
        topics: ["topic1"],
        adjectives: ["friendly"],
        clients: ["discord"],
        plugins: ["test-plugin"],
        style: {
            all: ["style1"],
            chat: ["chat-style"],
            post: ["post-style"],
        },
    };

    it("should validate correct character configuration", () => {
        expect(() =>
            validateCharacterConfig(validCharacterConfig)
        ).not.toThrow();
    });

    it("should validate configuration with optional fields", () => {
        const configWithOptionals = {
            ...validCharacterConfig,
            id: "123e4567-e89b-12d3-a456-426614174000",
            system: "Test system",
            templates: {
                greeting: "Hello!",
            },
            knowledge: ["fact1"],
            settings: {
                secrets: {
                    key: "value",
                },
                voice: {
                    model: "test-model",
                    url: "http://example.com",
                },
            },
        };
        expect(() =>
            validateCharacterConfig(configWithOptionals)
        ).not.toThrow();
    });

    it("should throw error for missing required fields", () => {
        const invalidConfig = { ...validCharacterConfig };
        (invalidConfig as any).name = undefined;
        expect(() => validateCharacterConfig(invalidConfig)).toThrow();
    });

    it("should validate plugin objects in plugins array", () => {
        const configWithPluginObjects = {
            ...validCharacterConfig,
            plugins: [
                {
                    name: "test-plugin",
                    description: "Test description",
                },
            ],
        };
        expect(() =>
            validateCharacterConfig(configWithPluginObjects)
        ).not.toThrow();
    });

    it("should validate client-specific configurations", () => {
        const configWithClientConfig = {
            ...validCharacterConfig,
            clientConfig: {
                discord: {
                    shouldIgnoreBotMessages: true,
                    shouldIgnoreDirectMessages: false,
                },
                telegram: {
                    shouldIgnoreBotMessages: true,
                    shouldIgnoreDirectMessages: true,
                },
            },
        };
        expect(() =>
            validateCharacterConfig(configWithClientConfig)
        ).not.toThrow();
    });

    it("should validate twitter profile configuration", () => {
        const configWithTwitter = {
            ...validCharacterConfig,
            twitterProfile: {
                username: "testuser",
                screenName: "Test User",
                bio: "Test bio",
                nicknames: ["test"],
            },
        };
        expect(() => validateCharacterConfig(configWithTwitter)).not.toThrow();
    });

    it("should validate model endpoint override", () => {
        const configWithEndpoint = {
            ...validCharacterConfig,
            modelEndpointOverride: "custom-endpoint",
        };
        expect(() => validateCharacterConfig(configWithEndpoint)).not.toThrow();
    });

    it("should validate message examples with additional properties", () => {
        const configWithComplexMessage = {
            ...validCharacterConfig,
            messageExamples: [
                [
                    {
                        user: "user1",
                        content: {
                            text: "Hello",
                            action: "wave",
                            source: "chat",
                            url: "http://example.com",
                            inReplyTo: "123e4567-e89b-12d3-a456-426614174000",
                            attachments: ["file1"],
                            customField: "value",
                        },
                    },
                ],
            ],
        };
        expect(() =>
            validateCharacterConfig(configWithComplexMessage)
        ).not.toThrow();
    });
});
