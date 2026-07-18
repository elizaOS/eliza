/**
 * Covers the canonical two-knob model pair resolver: runtime-vs-env precedence,
 * blank-string normalization, and provider-qualified family gating (the guard
 * that keeps a claude id out of an openai lane). Deterministic — env + a stub
 * SettingReader; no live model.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readCanonicalModel } from "../canonical-model";

const reader = (map: Record<string, string | null>) => ({
	getSetting: (key: string) => map[key] ?? null,
});

const SAVED = {
	small: process.env.ELIZA_MODEL_SMALL,
	large: process.env.ELIZA_MODEL_LARGE,
};

afterEach(() => {
	if (SAVED.small === undefined) delete process.env.ELIZA_MODEL_SMALL;
	else process.env.ELIZA_MODEL_SMALL = SAVED.small;
	if (SAVED.large === undefined) delete process.env.ELIZA_MODEL_LARGE;
	else process.env.ELIZA_MODEL_LARGE = SAVED.large;
});

describe("readCanonicalModel", () => {
	it("returns undefined when the pair is unset", () => {
		delete process.env.ELIZA_MODEL_SMALL;
		expect(readCanonicalModel(reader({}), "small", "openai")).toBeUndefined();
	});

	it("reads the env fallback when no runtime setting exists", () => {
		process.env.ELIZA_MODEL_LARGE = "claude-opus-4-8";
		expect(readCanonicalModel(reader({}), "large", "anthropic")).toBe(
			"claude-opus-4-8",
		);
	});

	it("prefers the runtime setting over env", () => {
		process.env.ELIZA_MODEL_SMALL = "env-model";
		const runtime = reader({ ELIZA_MODEL_SMALL: "setting-model" });
		expect(readCanonicalModel(runtime, "small", "openai")).toBe(
			"setting-model",
		);
	});

	it("treats blank strings as unset (no ?? masking)", () => {
		process.env.ELIZA_MODEL_SMALL = "   ";
		expect(readCanonicalModel(reader({}), "small", "openai")).toBeUndefined();
	});

	it("honors a qualified value only for its own family", () => {
		process.env.ELIZA_MODEL_LARGE = "anthropic/claude-opus-4-8";
		expect(readCanonicalModel(reader({}), "large", "anthropic")).toBe(
			"claude-opus-4-8",
		);
		expect(readCanonicalModel(reader({}), "large", "claude")).toBe(
			"claude-opus-4-8",
		);
		// The poisoning guard: an openai lane must never see a claude id.
		expect(readCanonicalModel(reader({}), "large", "openai")).toBeUndefined();
		expect(readCanonicalModel(reader({}), "large", "groq")).toBeUndefined();
	});

	it("gives an unqualified value to every family", () => {
		process.env.ELIZA_MODEL_SMALL = "gemma-4-31b";
		for (const family of ["openai", "cerebras", "elizacloud", "ollama"]) {
			expect(readCanonicalModel(reader({}), "small", family)).toBe(
				"gemma-4-31b",
			);
		}
	});

	it("rejects qualified values for family-agnostic callers", () => {
		process.env.ELIZA_MODEL_LARGE = "anthropic/claude-opus-4-8";
		expect(readCanonicalModel(reader({}), "large")).toBeUndefined();
		process.env.ELIZA_MODEL_LARGE = "zai-glm-4.7";
		expect(readCanonicalModel(reader({}), "large")).toBe("zai-glm-4.7");
	});

	it("maps cli-inference backends to their upstream families", () => {
		process.env.ELIZA_MODEL_SMALL = "claude/claude-sonnet-5";
		expect(readCanonicalModel(reader({}), "small", "claude")).toBe(
			"claude-sonnet-5",
		);
		process.env.ELIZA_MODEL_SMALL = "openai/gpt-5.5";
		expect(readCanonicalModel(reader({}), "small", "codex")).toBe("gpt-5.5");
	});

	it("treats unknown-prefix slash ids as whole model ids", () => {
		process.env.ELIZA_MODEL_SMALL = "meta-llama/llama-4-maverick";
		expect(readCanonicalModel(reader({}), "small", "groq")).toBe(
			"meta-llama/llama-4-maverick",
		);
		// family-agnostic callers also get the whole id (it is not a qualification)
		expect(readCanonicalModel(reader({}), "small")).toBe(
			"meta-llama/llama-4-maverick",
		);
	});

	it("supports family-pinning a slash-bearing native id", () => {
		process.env.ELIZA_MODEL_SMALL = "groq/openai/gpt-oss-120b";
		expect(readCanonicalModel(reader({}), "small", "groq")).toBe(
			"openai/gpt-oss-120b",
		);
		expect(readCanonicalModel(reader({}), "small", "cerebras")).toBeUndefined();
	});

	it("rejects a qualified value with an empty model part", () => {
		process.env.ELIZA_MODEL_SMALL = "anthropic/ ";
		expect(
			readCanonicalModel(reader({}), "small", "anthropic"),
		).toBeUndefined();
	});
});
