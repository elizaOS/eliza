import { afterEach, describe, expect, it, vi } from "vitest";
import { validateModelConfig } from "./config.ts";
import { ModelConfigSchema } from "./types.ts";

const baseConfig = {
	TEXT_EMBEDDING_MODEL: "local-embedding",
	MAX_INPUT_TOKENS: 4000,
};

const positiveIntegerFields = [
	"MAX_INPUT_TOKENS",
	"MAX_OUTPUT_TOKENS",
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
			MAX_INPUT_TOKENS: " 004000 ",
			MAX_OUTPUT_TOKENS: 2048,
			EMBEDDING_DIMENSION: "768",
			MAX_CONCURRENT_REQUESTS: "2",
			REQUESTS_PER_MINUTE: 60,
			TOKENS_PER_MINUTE: "100000",
			BATCH_DELAY_MS: "0",
		});

		expect(result).toMatchObject({
			MAX_INPUT_TOKENS: 4000,
			MAX_OUTPUT_TOKENS: 2048,
			EMBEDDING_DIMENSION: 768,
			MAX_CONCURRENT_REQUESTS: 2,
			REQUESTS_PER_MINUTE: 60,
			TOKENS_PER_MINUTE: 100000,
			BATCH_DELAY_MS: 0,
		});

		const defaults = ModelConfigSchema.parse(baseConfig);
		expect(defaults).toMatchObject({
			MAX_OUTPUT_TOKENS: 4096,
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
});
