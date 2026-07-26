/**
 * Exercises model-pair precedence and family gating with deterministic
 * per-agent settings and environment records; no provider or model is mocked.
 */

import { describe, expect, it } from "vitest";
import {
	CANONICAL_MODEL_ENV_KEYS,
	type CanonicalModelFamily,
	canonicalModelIsQualified,
	readCanonicalModel,
} from "./canonical-model";

const EMPTY_ENV = {};

function reader(
	values: Record<string, string | number | boolean | null | undefined>,
) {
	return {
		getSetting: (key: string) => values[key] ?? null,
	};
}

function options(small?: string, large?: string): { env: NodeJS.ProcessEnv } {
	return {
		env: {
			ELIZA_MODEL_SMALL: small,
			ELIZA_MODEL_LARGE: large,
		},
	};
}

describe("canonical model pair contract", () => {
	it("binds each tier to one stable environment key", () => {
		expect(CANONICAL_MODEL_ENV_KEYS).toEqual({
			small: "ELIZA_MODEL_SMALL",
			large: "ELIZA_MODEL_LARGE",
		});
	});

	it("returns undefined when a tier is absent or blank", () => {
		expect(
			readCanonicalModel(null, "small", "openai", { env: EMPTY_ENV }),
		).toBeUndefined();
		expect(
			readCanonicalModel(null, "small", "openai", options(" \t ")),
		).toBeUndefined();
	});

	it("keeps the small and large tiers independent", () => {
		const env = options("small-model", "large-model");
		expect(readCanonicalModel(null, "small", "openai", env)).toBe(
			"small-model",
		);
		expect(readCanonicalModel(null, "large", "openai", env)).toBe(
			"large-model",
		);
	});

	it("prefers a per-agent setting over the deployment environment", () => {
		const runtime = reader({ ELIZA_MODEL_SMALL: "agent-model" });
		expect(
			readCanonicalModel(
				runtime,
				"small",
				"openai",
				options("deployment-model"),
			),
		).toBe("agent-model");
	});

	it("treats a blank per-agent string as unset and reads the environment", () => {
		const runtime = reader({ ELIZA_MODEL_SMALL: "  " });
		expect(
			readCanonicalModel(
				runtime,
				"small",
				"openai",
				options("deployment-model"),
			),
		).toBe("deployment-model");
	});

	it.each([false, true, 0, 42])(
		"rejects the explicit non-string runtime value %j without leaking the environment fallback",
		(runtimeValue) => {
			const runtime = reader({ ELIZA_MODEL_SMALL: runtimeValue });
			expect(
				readCanonicalModel(
					runtime,
					"small",
					"openai",
					options("deployment-model"),
				),
			).toBeUndefined();
		},
	);

	it("shares an unqualified model across every supported family", () => {
		const families: CanonicalModelFamily[] = [
			"openai",
			"anthropic",
			"ollama",
			"google",
			"elizacloud",
			"cerebras",
			"groq",
			"claude",
			"codex",
		];
		for (const family of families) {
			expect(
				readCanonicalModel(null, "small", family, options("shared-model")),
			).toBe("shared-model");
		}
	});

	it.each([
		["anthropic/claude-opus", "anthropic", "claude-opus"],
		["claude/claude-opus", "anthropic", "claude-opus"],
		["anthropic/claude-opus", "claude", "claude-opus"],
		["openai/gpt-5", "openai", "gpt-5"],
		["gpt/gpt-5", "codex", "gpt-5"],
		["google-genai/gemini-pro", "google", "gemini-pro"],
		["gemini/gemini-flash", "google", "gemini-flash"],
		["eliza-cloud/fast", "elizacloud", "fast"],
		["cloud/large", "elizacloud", "large"],
	] as const)("accepts %s for the %s family", (value, family, expected) => {
		expect(
			readCanonicalModel(null, "large", family, options(undefined, value)),
		).toBe(expected);
	});

	it("matches qualifier tokens case-insensitively and preserves model casing", () => {
		expect(
			readCanonicalModel(
				null,
				"large",
				"anthropic",
				options(undefined, "  AnThRoPiC / Claude-Opus-4-8  "),
			),
		).toBe("Claude-Opus-4-8");
	});

	it("rejects a qualified value for every nonmatching family", () => {
		const env = options(undefined, "anthropic/claude-opus");
		for (const family of [
			"openai",
			"google",
			"groq",
			"cerebras",
			"codex",
		] as const) {
			expect(readCanonicalModel(null, "large", family, env)).toBeUndefined();
		}
	});

	it("rejects a qualified value when the caller cannot prove its family", () => {
		expect(
			readCanonicalModel(
				null,
				"large",
				undefined,
				options(undefined, "anthropic/claude-opus"),
			),
		).toBeUndefined();
	});

	it.each(["anthrpic", "toString", "__proto__"])(
		"fails closed for unsupported caller family %s at the JavaScript boundary",
		(unsupportedFamily) => {
			const unsupported = unsupportedFamily as CanonicalModelFamily;
			expect(
				readCanonicalModel(
					null,
					"large",
					unsupported,
					options(undefined, "anthropic/claude-opus"),
				),
			).toBeUndefined();
			expect(
				readCanonicalModel(
					null,
					"large",
					unsupported,
					options(undefined, "shared-model"),
				),
			).toBeUndefined();
		},
	);

	it("preserves unknown-prefix slash ids as native model ids", () => {
		const nativeId = "meta-llama/llama-4-maverick";
		expect(readCanonicalModel(null, "small", "groq", options(nativeId))).toBe(
			nativeId,
		);
		expect(
			readCanonicalModel(null, "small", undefined, options(nativeId)),
		).toBe(nativeId);
	});

	it("supports family-pinning a slash-bearing native id", () => {
		const pinned = options("groq/openai/gpt-oss-120b");
		expect(readCanonicalModel(null, "small", "groq", pinned)).toBe(
			"openai/gpt-oss-120b",
		);
		expect(
			readCanonicalModel(null, "small", "cerebras", pinned),
		).toBeUndefined();
	});

	it("treats a colliding known prefix as a qualifier", () => {
		const env = options("openai/gpt-oss-120b");
		expect(readCanonicalModel(null, "small", "openai", env)).toBe(
			"gpt-oss-120b",
		);
		expect(readCanonicalModel(null, "small", "groq", env)).toBeUndefined();
	});

	it.each([
		"anthropic/",
		"anthropic/ ",
		"anthropic//claude-opus",
		"/model",
		"model\u0000name",
		"model\nname",
	])("rejects malformed model value %j", (value) => {
		expect(
			readCanonicalModel(null, "large", "anthropic", options(undefined, value)),
		).toBeUndefined();
	});

	it("does not fall through to env after a malformed per-agent value", () => {
		const runtime = reader({ ELIZA_MODEL_LARGE: "anthropic/" });
		expect(
			readCanonicalModel(
				runtime,
				"large",
				"anthropic",
				options(undefined, "anthropic/env-model"),
			),
		).toBeUndefined();
	});
});

describe("canonicalModelIsQualified", () => {
	it("recognizes valid family qualifications but not native slash ids", () => {
		expect(
			canonicalModelIsQualified(
				null,
				"large",
				options(undefined, "anthropic/claude-opus"),
			),
		).toBe(true);
		expect(
			canonicalModelIsQualified(
				null,
				"large",
				options(undefined, "meta-llama/llama-4"),
			),
		).toBe(false);
	});

	it("returns false for missing, malformed, or mistyped runtime values", () => {
		expect(canonicalModelIsQualified(null, "large", { env: EMPTY_ENV })).toBe(
			false,
		);
		expect(
			canonicalModelIsQualified(
				null,
				"large",
				options(undefined, "anthropic/"),
			),
		).toBe(false);
		expect(
			canonicalModelIsQualified(
				reader({ ELIZA_MODEL_LARGE: true }),
				"large",
				options(undefined, "anthropic/env-model"),
			),
		).toBe(false);
	});

	it("uses env after a blank runtime value", () => {
		expect(
			canonicalModelIsQualified(
				reader({ ELIZA_MODEL_LARGE: " " }),
				"large",
				options(undefined, "anthropic/env-model"),
			),
		).toBe(true);
	});
});
