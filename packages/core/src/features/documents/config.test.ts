/**
 * Covers the documents model-configuration boundary in config.ts: provider
 * resolution and credential requirements, local-embedding inference, boolean
 * flag parsing, runtime-setting precedence, model-gateway override/scrubbing
 * with strict fail-closed mode, and the rate-limit envelope derived by
 * getProviderRateLimits. Deterministic harness: the real module and zod schema
 * run against a managed process.env snapshot, with a minimal getSetting stub
 * standing in for IAgentRuntime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelGatewayStrictError } from "../../model-gateway.ts";
import type { IAgentRuntime } from "../../types";
import { getProviderRateLimits, validateModelConfig } from "./config.ts";

const MANAGED_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"BATCH_DELAY_MS",
	"CTX_DOCUMENTS_ENABLED",
	"ELIZA_MODEL_GATEWAY_STRICT",
	"ELIZA_MODEL_GATEWAY_TOKEN",
	"ELIZA_MODEL_GATEWAY_URL",
	"EMBEDDING_DIMENSION",
	"EMBEDDING_PROVIDER",
	"GOOGLE_API_KEY",
	"LOAD_DOCS_ON_STARTUP",
	"LOCAL_EMBEDDING_DIMENSIONS",
	"LOCAL_EMBEDDING_MODEL",
	"MAX_CONCURRENT_REQUESTS",
	"MAX_INPUT_TOKENS",
	"MAX_OUTPUT_TOKENS",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENAI_EMBEDDING_DIMENSIONS",
	"OPENAI_EMBEDDING_MODEL",
	"OPENROUTER_API_KEY",
	"RATE_LIMIT_ENABLED",
	"REQUESTS_PER_MINUTE",
	"TEXT_EMBEDDING_MODEL",
	"TEXT_MODEL",
	"TEXT_PROVIDER",
	"TOKENS_PER_MINUTE",
] as const;

let savedEnv: Record<string, string | undefined> = {};

const setEnv = (values: Record<string, string | undefined>) => {
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
};

beforeEach(() => {
	savedEnv = {};
	for (const key of MANAGED_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of MANAGED_ENV_KEYS) {
		const previous = savedEnv[key];
		if (previous === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = previous;
		}
	}
});

function runtimeWithSettings(
	settings: Record<string, string | undefined>,
): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key],
	} as unknown as IAgentRuntime;
}

describe("validateModelConfig provider resolution", () => {
	it("applies the configuration-boundary defaults to an empty environment", () => {
		const config = validateModelConfig();

		expect(config.EMBEDDING_PROVIDER).toBeUndefined();
		expect(config.TEXT_PROVIDER).toBeUndefined();
		expect(config.TEXT_MODEL).toBeUndefined();
		expect(config.OPENAI_API_KEY).toBeUndefined();
		expect(config.MAX_OUTPUT_TOKENS).toBeUndefined();
		expect(config.TEXT_EMBEDDING_MODEL).toBe("text-embedding-3-small");
		expect(config.EMBEDDING_DIMENSION).toBe(1536);
		expect(config.MAX_INPUT_TOKENS).toBe(4000);
		expect(config.RATE_LIMIT_ENABLED).toBe(true);
		expect(config.LOAD_DOCS_ON_STARTUP).toBe(false);
		expect(config.CTX_DOCUMENTS_ENABLED).toBe(false);
	});

	it("trims surrounding whitespace from provider credentials and base URLs", () => {
		setEnv({
			EMBEDDING_PROVIDER: "  openai  ",
			OPENAI_API_KEY: "  sk-test-key  ",
			OPENAI_BASE_URL: "  https://api.openai.example/v1  ",
		});

		const config = validateModelConfig();

		expect(config.EMBEDDING_PROVIDER).toBe("openai");
		expect(config.OPENAI_API_KEY).toBe("sk-test-key");
		expect(config.OPENAI_BASE_URL).toBe("https://api.openai.example/v1");
	});

	it('requires OPENAI_API_KEY when EMBEDDING_PROVIDER is "openai"', () => {
		setEnv({ EMBEDDING_PROVIDER: "openai" });

		expect(() => validateModelConfig()).toThrow(
			'OPENAI_API_KEY is required when EMBEDDING_PROVIDER is set to "openai"',
		);
	});

	it("resolves OpenAI embeddings with the OpenAI model and dimension aliases", () => {
		setEnv({
			EMBEDDING_PROVIDER: "openai",
			OPENAI_API_KEY: "sk-test-key",
			OPENAI_EMBEDDING_MODEL: "text-embedding-3-large",
			OPENAI_EMBEDDING_DIMENSIONS: "3072",
		});

		const config = validateModelConfig();

		expect(config).toMatchObject({
			EMBEDDING_PROVIDER: "openai",
			TEXT_EMBEDDING_MODEL: "text-embedding-3-large",
			EMBEDDING_DIMENSION: 3072,
		});
	});

	it("keeps the plugin-openai default model when no alias is set", () => {
		setEnv({ EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "sk-test-key" });

		const config = validateModelConfig();

		expect(config.TEXT_EMBEDDING_MODEL).toBe("text-embedding-3-small");
		expect(config.EMBEDDING_DIMENSION).toBe(1536);
	});

	it('requires GOOGLE_API_KEY when EMBEDDING_PROVIDER is "google"', () => {
		setEnv({ EMBEDDING_PROVIDER: "google" });

		expect(() => validateModelConfig()).toThrow(
			'GOOGLE_API_KEY is required when EMBEDDING_PROVIDER is set to "google"',
		);
	});

	it("resolves Google embeddings once its key is present", () => {
		setEnv({ EMBEDDING_PROVIDER: "google", GOOGLE_API_KEY: "g-key" });

		const config = validateModelConfig();

		expect(config).toMatchObject({
			EMBEDDING_PROVIDER: "google",
			EMBEDDING_DIMENSION: 1536,
		});
	});

	it("resolves local embeddings without any provider credential", () => {
		setEnv({ EMBEDDING_PROVIDER: "local" });

		const config = validateModelConfig();

		expect(config).toMatchObject({
			EMBEDDING_PROVIDER: "local",
			TEXT_EMBEDDING_MODEL: "local-embedding",
			EMBEDDING_DIMENSION: 384,
		});
	});
});

describe("validateModelConfig local-embedding inference", () => {
	it("infers local embeddings from LOCAL_EMBEDDING_MODEL alone", () => {
		setEnv({ LOCAL_EMBEDDING_MODEL: "bge-small-en" });

		const config = validateModelConfig();

		expect(config).toMatchObject({
			EMBEDDING_PROVIDER: "local",
			TEXT_EMBEDDING_MODEL: "bge-small-en",
			EMBEDDING_DIMENSION: 384,
		});
	});

	it("infers local embeddings from LOCAL_EMBEDDING_DIMENSIONS alone", () => {
		setEnv({ LOCAL_EMBEDDING_DIMENSIONS: "512" });

		const config = validateModelConfig();

		expect(config).toMatchObject({
			EMBEDDING_PROVIDER: "local",
			TEXT_EMBEDDING_MODEL: "local-embedding",
			EMBEDDING_DIMENSION: 512,
		});
	});

	it("lets an explicit EMBEDDING_DIMENSION override the local default", () => {
		setEnv({ EMBEDDING_PROVIDER: "local", EMBEDDING_DIMENSION: "256" });

		expect(validateModelConfig().EMBEDDING_DIMENSION).toBe(256);
	});

	it("ignores the OpenAI dimension alias for explicit local embeddings", () => {
		setEnv({
			EMBEDDING_PROVIDER: "local",
			OPENAI_EMBEDDING_DIMENSIONS: "3072",
		});

		expect(validateModelConfig().EMBEDDING_DIMENSION).toBe(384);
	});
});

describe("validateModelConfig setting precedence", () => {
	it("lets a runtime embedding provider beat the environment", () => {
		setEnv({ EMBEDDING_PROVIDER: "google" });
		const runtime = runtimeWithSettings({ EMBEDDING_PROVIDER: "local" });

		const config = validateModelConfig(runtime);

		expect(config).toMatchObject({
			EMBEDDING_PROVIDER: "local",
			EMBEDDING_DIMENSION: 384,
		});
	});

	it("falls through to the environment when the runtime value is blank", () => {
		setEnv({ EMBEDDING_PROVIDER: "local" });
		const runtime = runtimeWithSettings({ EMBEDDING_PROVIDER: "   " });

		const config = validateModelConfig(runtime);

		expect(config).toMatchObject({
			EMBEDDING_PROVIDER: "local",
			EMBEDDING_DIMENSION: 384,
		});
	});
});

describe("validateModelConfig boolean flag parsing", () => {
	it.each([
		["true", true],
		["TRUE", true],
		["1", false],
		["0", false],
		["yes", false],
		["", false],
	] as const)("parses CTX_DOCUMENTS_ENABLED=%j as %j", (value, expected) => {
		setEnv({ CTX_DOCUMENTS_ENABLED: value });

		expect(validateModelConfig().CTX_DOCUMENTS_ENABLED).toBe(expected);
	});

	it("honours LOAD_DOCS_ON_STARTUP independently of the context gate", () => {
		setEnv({ LOAD_DOCS_ON_STARTUP: "true", CTX_DOCUMENTS_ENABLED: "false" });

		const config = validateModelConfig();

		expect(config.LOAD_DOCS_ON_STARTUP).toBe(true);
		expect(config.CTX_DOCUMENTS_ENABLED).toBe(false);
	});
});

describe("validateModelConfig context-document credential gates", () => {
	it.each([
		["openai", "OPENAI_API_KEY"],
		["anthropic", "ANTHROPIC_API_KEY"],
		["openrouter", "OPENROUTER_API_KEY"],
		["google", "GOOGLE_API_KEY"],
	] as const)(
		'requires %s when TEXT_PROVIDER is "%s" and documents are enabled',
		(provider, keyVar) => {
			setEnv({ CTX_DOCUMENTS_ENABLED: "true", TEXT_PROVIDER: provider });

			expect(() => validateModelConfig()).toThrow(
				`${keyVar} is required when TEXT_PROVIDER is set to "${provider}"`,
			);
		},
	);

	it("resolves every enabled text provider once its key is present", () => {
		setEnv({
			CTX_DOCUMENTS_ENABLED: "true",
			TEXT_PROVIDER: "anthropic",
			ANTHROPIC_API_KEY: "a-key",
			OPENAI_API_KEY: "o-key",
			OPENROUTER_API_KEY: "r-key",
			GOOGLE_API_KEY: "g-key",
		});

		const config = validateModelConfig();

		expect(config).toMatchObject({
			CTX_DOCUMENTS_ENABLED: true,
			TEXT_PROVIDER: "anthropic",
		});
	});

	it("does not gate text providers while document context stays disabled", () => {
		setEnv({ TEXT_PROVIDER: "openai" });

		const config = validateModelConfig();

		expect(config).toMatchObject({
			CTX_DOCUMENTS_ENABLED: false,
			TEXT_PROVIDER: "openai",
		});
	});
});

describe("validateModelConfig gateway handling", () => {
	it("passes raw OpenAI-compatible credentials through unchanged by default", () => {
		setEnv({
			OPENAI_API_KEY: "sk-raw-key",
			OPENAI_BASE_URL: "https://raw.example/v1",
		});

		const config = validateModelConfig();

		expect(config.OPENAI_API_KEY).toBe("sk-raw-key");
		expect(config.OPENAI_BASE_URL).toBe("https://raw.example/v1");
	});

	it("replaces the base URL and scrubs the raw key when the gateway is on", () => {
		setEnv({
			ELIZA_MODEL_GATEWAY_URL: "https://gateway.example/v1",
			ELIZA_MODEL_GATEWAY_TOKEN: "gateway-token",
			OPENAI_API_KEY: "sk-raw-key",
			OPENAI_BASE_URL: "https://raw.example/v1",
		});

		const config = validateModelConfig();

		expect(config.OPENAI_BASE_URL).toBe("https://gateway.example/v1");
		expect(config.OPENAI_API_KEY).toBe("gateway-token");
	});

	it("leaves no api key when the gateway is on without a token", () => {
		setEnv({
			ELIZA_MODEL_GATEWAY_URL: "https://gateway.example/v1",
			OPENAI_API_KEY: "sk-raw-key",
		});

		const config = validateModelConfig();

		expect(config.OPENAI_BASE_URL).toBe("https://gateway.example/v1");
		expect(config.OPENAI_API_KEY).toBeUndefined();
	});

	it("fails closed in strict gateway mode when a raw provider key is present", () => {
		setEnv({
			ELIZA_MODEL_GATEWAY_URL: "https://gateway.example/v1",
			ELIZA_MODEL_GATEWAY_STRICT: "true",
			OPENAI_API_KEY: "sk-raw-key",
		});

		let caught: unknown;
		try {
			validateModelConfig();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ModelGatewayStrictError);
		expect((caught as Error).message).toContain("OPENAI_API_KEY");
	});

	it("keeps strict gateway mode working when no raw provider key is set", () => {
		setEnv({
			ELIZA_MODEL_GATEWAY_URL: "https://gateway.example/v1",
			ELIZA_MODEL_GATEWAY_TOKEN: "gateway-token",
			ELIZA_MODEL_GATEWAY_STRICT: "true",
		});

		const config = validateModelConfig();

		expect(config.OPENAI_BASE_URL).toBe("https://gateway.example/v1");
		expect(config.OPENAI_API_KEY).toBe("gateway-token");
	});
});

describe("getProviderRateLimits", () => {
	it("derives the enabled envelope from the numeric settings", async () => {
		setEnv({
			TEXT_PROVIDER: "anthropic",
			MAX_CONCURRENT_REQUESTS: "25",
			REQUESTS_PER_MINUTE: "60",
			TOKENS_PER_MINUTE: "90000",
			BATCH_DELAY_MS: "5",
		});

		await expect(getProviderRateLimits()).resolves.toEqual({
			maxConcurrentRequests: 25,
			requestsPerMinute: 60,
			tokensPerMinute: 90_000,
			provider: "anthropic",
			rateLimitEnabled: true,
			batchDelayMs: 5,
		});
	});

	it("prefers TEXT_PROVIDER over EMBEDDING_PROVIDER and falls back to unlimited", async () => {
		setEnv({
			TEXT_PROVIDER: "anthropic",
			EMBEDDING_PROVIDER: "openai",
			OPENAI_API_KEY: "sk-test-key",
		});

		await expect(getProviderRateLimits()).resolves.toMatchObject({
			provider: "anthropic",
		});

		setEnv({
			TEXT_PROVIDER: undefined,
			EMBEDDING_PROVIDER: undefined,
		});

		await expect(getProviderRateLimits()).resolves.toMatchObject({
			provider: "unlimited",
			rateLimitEnabled: true,
		});
	});

	it("reports the embedding provider when no text provider is set", async () => {
		setEnv({ EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "sk-test-key" });

		await expect(getProviderRateLimits()).resolves.toMatchObject({
			provider: "openai",
		});
	});

	it("unbounds per-minute ceilings but keeps concurrency when limiting is off", async () => {
		setEnv({
			EMBEDDING_PROVIDER: "local",
			RATE_LIMIT_ENABLED: "false",
			MAX_CONCURRENT_REQUESTS: "8",
			BATCH_DELAY_MS: "250",
		});

		await expect(getProviderRateLimits()).resolves.toEqual({
			maxConcurrentRequests: 8,
			requestsPerMinute: Number.MAX_SAFE_INTEGER,
			tokensPerMinute: Number.MAX_SAFE_INTEGER,
			provider: "local",
			rateLimitEnabled: false,
			batchDelayMs: 250,
		});
	});
});
