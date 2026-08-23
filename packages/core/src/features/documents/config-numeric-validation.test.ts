/**
 * Exercises strict document numeric-setting schemas and the real
 * validateModelConfig boundary with deterministic environment and runtime-
 * setting inputs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../../types";
import { validateModelConfig } from "./config.ts";
import { ModelConfigSchema } from "./types.ts";

const baseConfig = {
	TEXT_EMBEDDING_MODEL: "local-embedding",
};

const positiveIntegerFields = [
	"EMBEDDING_DIMENSION",
	"MAX_CONCURRENT_REQUESTS",
	"REQUESTS_PER_MINUTE",
	"TOKENS_PER_MINUTE",
] as const;

const malformedValues = [
	"10junk",
	"1e3",
	"1.5",
	1.5,
	"+1",
	"-1",
	"-0",
	"",
	"   ",
	Number.NaN,
	Number.POSITIVE_INFINITY,
	String(Number.MAX_SAFE_INTEGER + 1),
	Number.MAX_SAFE_INTEGER + 1,
	-1,
	-0,
];

function runtimeWithSettings(
	settings: Record<string, string | undefined>,
): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key],
	} as unknown as IAgentRuntime;
}

describe("ModelConfigSchema numeric settings", () => {
	it.each(positiveIntegerFields)(
		"rejects malformed, unsafe, zero, and negative %s values",
		(field) => {
			for (const value of [...malformedValues, 0, "0"]) {
				const result = ModelConfigSchema.safeParse({
					...baseConfig,
					[field]: value,
				});
				expect(
					result.success,
					`${field} unexpectedly accepted ${String(value)}`,
				).toBe(false);
			}
		},
	);

	it("accepts complete safe integers and preserves defaults", () => {
		const result = ModelConfigSchema.parse({
			...baseConfig,
			EMBEDDING_DIMENSION: "768",
			MAX_CONCURRENT_REQUESTS: "2",
			REQUESTS_PER_MINUTE: 60,
			TOKENS_PER_MINUTE: "100000",
			BATCH_DELAY_MS: "0",
		});

		expect(result).toMatchObject({
			EMBEDDING_DIMENSION: 768,
			MAX_CONCURRENT_REQUESTS: 2,
			REQUESTS_PER_MINUTE: 60,
			TOKENS_PER_MINUTE: 100000,
			BATCH_DELAY_MS: 0,
		});

		const defaults = ModelConfigSchema.parse(baseConfig);
		expect(defaults).toMatchObject({
			EMBEDDING_DIMENSION: 1536,
			MAX_CONCURRENT_REQUESTS: 150,
			REQUESTS_PER_MINUTE: 300,
			TOKENS_PER_MINUTE: 750000,
			BATCH_DELAY_MS: 100,
		});
	});

	it("allows only nonnegative safe integers for BATCH_DELAY_MS", () => {
		for (const value of malformedValues) {
			const result = ModelConfigSchema.safeParse({
				...baseConfig,
				BATCH_DELAY_MS: value,
			});
			expect(
				result.success,
				`BATCH_DELAY_MS unexpectedly accepted ${String(value)}`,
			).toBe(false);
		}

		expect(
			ModelConfigSchema.parse({ ...baseConfig, BATCH_DELAY_MS: 0 })
				.BATCH_DELAY_MS,
		).toBe(0);
		expect(
			ModelConfigSchema.parse({
				...baseConfig,
				BATCH_DELAY_MS: 2_147_483_647,
			}).BATCH_DELAY_MS,
		).toBe(2_147_483_647);
		expect(
			ModelConfigSchema.safeParse({
				...baseConfig,
				BATCH_DELAY_MS: 2_147_483_648,
			}).success,
		).toBe(false);
	});
});

describe("validateModelConfig numeric boundary", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each(["-2", "", "   ", "2junk", "1e3", "1.5"])(
		"rejects invalid concurrency %j before document ingestion",
		(value) => {
			vi.stubEnv("EMBEDDING_PROVIDER", "local");
			vi.stubEnv("TEXT_EMBEDDING_MODEL", "local-embedding");
			vi.stubEnv("MAX_CONCURRENT_REQUESTS", value);

			expect(() => validateModelConfig()).toThrow(
				/Model configuration validation failed: MAX_CONCURRENT_REQUESTS:/,
			);
		},
	);

	it("enforces the runtime timer ceiling for batch delays", () => {
		vi.stubEnv("EMBEDDING_PROVIDER", "local");
		vi.stubEnv("TEXT_EMBEDDING_MODEL", "local-embedding");
		vi.stubEnv("BATCH_DELAY_MS", "2147483647");

		expect(validateModelConfig().BATCH_DELAY_MS).toBe(2_147_483_647);

		vi.stubEnv("BATCH_DELAY_MS", "2147483648");
		expect(() => validateModelConfig()).toThrow(
			/Model configuration validation failed: BATCH_DELAY_MS:/,
		);
	});

	it.each([
		["LOCAL_EMBEDDING_DIMENSIONS", "local", "", 384],
		["LOCAL_EMBEDDING_DIMENSIONS", "local", "   ", 384],
		["OPENAI_EMBEDDING_DIMENSIONS", "openai", "", 1536],
		["OPENAI_EMBEDDING_DIMENSIONS", "openai", "   ", 1536],
	] as const)(
		"treats a blank %s alias as unset and uses the provider default",
		(setting, provider, value, expected) => {
			vi.stubEnv("EMBEDDING_PROVIDER", provider);
			vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
			vi.stubEnv(setting, value);

			expect(validateModelConfig()).toMatchObject({
				EMBEDDING_PROVIDER: provider,
				EMBEDDING_DIMENSION: expected,
			});
		},
	);

	it("treats a blank OpenAI alias as unset when OpenAI is inferred", () => {
		vi.stubEnv("EMBEDDING_PROVIDER", undefined);
		vi.stubEnv("OPENAI_EMBEDDING_DIMENSIONS", "");

		expect(validateModelConfig()).toMatchObject({
			EMBEDDING_DIMENSION: 1536,
		});
	});

	it.each([
		["EMBEDDING_DIMENSION", "3072", 3072],
		["OPENAI_EMBEDDING_DIMENSIONS", "3072", 3072],
	] as const)(
		"lets a valid %s env value win over a blank runtime alias (#18897)",
		(setting, envValue, expected) => {
			vi.stubEnv("EMBEDDING_PROVIDER", "openai");
			vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
			vi.stubEnv(setting, envValue);
			const runtime = {
				getSetting: (key: string) => (key === setting ? "   " : undefined),
			} as never;

			expect(validateModelConfig(runtime)).toMatchObject({
				EMBEDDING_PROVIDER: "openai",
				EMBEDDING_DIMENSION: expected,
			});
		},
	);

	it("falls to the provider default when the runtime alias is blank and no env alias is set (#18897)", () => {
		vi.stubEnv("EMBEDDING_PROVIDER", "openai");
		vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
		const runtime = {
			getSetting: (key: string) =>
				key === "EMBEDDING_DIMENSION" ? "" : undefined,
		} as never;

		expect(validateModelConfig(runtime)).toMatchObject({
			EMBEDDING_DIMENSION: 1536,
		});
	});

	it("ignores inactive local and OpenAI aliases for Google embeddings", () => {
		vi.stubEnv("EMBEDDING_PROVIDER", "google");
		vi.stubEnv("GOOGLE_API_KEY", "test-google-key");
		vi.stubEnv("LOCAL_EMBEDDING_DIMENSIONS", "   ");
		vi.stubEnv("OPENAI_EMBEDDING_DIMENSIONS", "");

		expect(validateModelConfig()).toMatchObject({
			EMBEDDING_PROVIDER: "google",
			EMBEDDING_DIMENSION: 1536,
		});
	});

	it("lets a Google runtime ignore its inactive blank OpenAI alias", () => {
		vi.stubEnv("OPENAI_EMBEDDING_DIMENSIONS", "4096");
		vi.stubEnv("EMBEDDING_DIMENSION", undefined);
		const runtime = runtimeWithSettings({
			EMBEDDING_PROVIDER: "google",
			GOOGLE_API_KEY: "test-google-key",
			OPENAI_EMBEDDING_DIMENSIONS: "",
		});

		expect(validateModelConfig(runtime)).toMatchObject({
			EMBEDDING_PROVIDER: "google",
			EMBEDDING_DIMENSION: 1536,
		});
	});

	it("preserves the real configuration-boundary defaults", () => {
		vi.stubEnv("EMBEDDING_PROVIDER", "local");

		expect(validateModelConfig()).toMatchObject({
			EMBEDDING_DIMENSION: 384,
			MAX_CONCURRENT_REQUESTS: 100,
			REQUESTS_PER_MINUTE: 500,
			TOKENS_PER_MINUTE: 1_000_000,
			BATCH_DELAY_MS: 100,
		});
	});
});
