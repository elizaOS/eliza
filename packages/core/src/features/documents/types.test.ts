/**
 * Covers `ModelConfigSchema`, the documents capability's model-configuration
 * validation boundary consumed by `validateModelConfig` at service startup:
 * required keys without defaults, provider enum membership, boolean flag
 * defaults, the safe-integer ceiling, and union rejection of non-string /
 * non-number inputs. Deterministic: every case drives the real exported
 * schema with no mocks and no environment coupling.
 */
import { describe, expect, it } from "vitest";
import { ModelConfigSchema } from "./types.ts";

const minimalValidConfig = {
	TEXT_EMBEDDING_MODEL: "local-embedding",
	MAX_INPUT_TOKENS: 4000,
};

describe("ModelConfigSchema", () => {
	it("requires TEXT_EMBEDDING_MODEL", () => {
		const result = ModelConfigSchema.safeParse({
			MAX_INPUT_TOKENS: 4000,
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((issue) =>
					issue.path.includes("TEXT_EMBEDDING_MODEL"),
				),
			).toBe(true);
		}
	});

	it("requires MAX_INPUT_TOKENS because it carries no default", () => {
		const result = ModelConfigSchema.safeParse({
			TEXT_EMBEDDING_MODEL: "local-embedding",
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((issue) =>
					issue.path.includes("MAX_INPUT_TOKENS"),
				),
			).toBe(true);
		}
	});

	it("accepts every supported embedding provider and preserves it", () => {
		for (const provider of ["local", "openai", "google"] as const) {
			expect(
				ModelConfigSchema.parse({
					...minimalValidConfig,
					EMBEDDING_PROVIDER: provider,
				}).EMBEDDING_PROVIDER,
			).toBe(provider);
		}
	});

	it("rejects an embedding provider outside the supported set", () => {
		expect(
			ModelConfigSchema.safeParse({
				...minimalValidConfig,
				EMBEDDING_PROVIDER: "azure",
			}).success,
		).toBe(false);
	});

	it.each(["openai", "anthropic", "openrouter", "google"] as const)(
		"accepts %s as a text provider",
		(provider) => {
			expect(
				ModelConfigSchema.parse({
					...minimalValidConfig,
					TEXT_PROVIDER: provider,
				}).TEXT_PROVIDER,
			).toBe(provider);
		},
	);

	it("rejects a text provider outside the supported set", () => {
		expect(
			ModelConfigSchema.safeParse({
				...minimalValidConfig,
				TEXT_PROVIDER: "cohere",
			}).success,
		).toBe(false);
	});

	it("leaves optional providers unset when omitted", () => {
		const parsed = ModelConfigSchema.parse(minimalValidConfig);

		expect(parsed.EMBEDDING_PROVIDER).toBeUndefined();
		expect(parsed.TEXT_PROVIDER).toBeUndefined();
	});

	it("defaults the document-loading and rate-limit flags", () => {
		expect(ModelConfigSchema.parse(minimalValidConfig)).toMatchObject({
			LOAD_DOCS_ON_STARTUP: false,
			CTX_DOCUMENTS_ENABLED: false,
			RATE_LIMIT_ENABLED: true,
		});
	});

	it("lets explicit flag overrides win over the defaults", () => {
		expect(
			ModelConfigSchema.parse({
				...minimalValidConfig,
				LOAD_DOCS_ON_STARTUP: true,
				CTX_DOCUMENTS_ENABLED: true,
				RATE_LIMIT_ENABLED: false,
			}),
		).toMatchObject({
			LOAD_DOCS_ON_STARTUP: true,
			CTX_DOCUMENTS_ENABLED: true,
			RATE_LIMIT_ENABLED: false,
		});
	});

	it("rejects settings matching neither string nor number union member", () => {
		for (const value of [null, true, { tokens: 4000 }, [4000]]) {
			const result = ModelConfigSchema.safeParse({
				...minimalValidConfig,
				MAX_INPUT_TOKENS: value,
			});

			expect(result.success, `unexpectedly accepted ${String(value)}`).toBe(
				false,
			);
		}
	});

	it("accepts Number.MAX_SAFE_INTEGER as the unbounded setting ceiling", () => {
		const numberForm = ModelConfigSchema.parse({
			...minimalValidConfig,
			TOKENS_PER_MINUTE: Number.MAX_SAFE_INTEGER,
		});

		expect(numberForm.TOKENS_PER_MINUTE).toBe(Number.MAX_SAFE_INTEGER);

		const stringForm = ModelConfigSchema.parse({
			TEXT_EMBEDDING_MODEL: "local-embedding",
			MAX_INPUT_TOKENS: "9007199254740991",
			TOKENS_PER_MINUTE: "9007199254740991",
		});

		expect(stringForm.MAX_INPUT_TOKENS).toBe(Number.MAX_SAFE_INTEGER);
		expect(stringForm.TOKENS_PER_MINUTE).toBe(Number.MAX_SAFE_INTEGER);
	});
});
