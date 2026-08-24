/**
 * Behavioral coverage for the validation barrel entry point: every runtime
 * export consumers reach through src/validation/index must resolve to a
 * working implementation. Drives the real functions through the public
 * import path, exercising branches the submodule suites leave open (missing
 * recent-history, maximum-length rejection, empty requirement sets, and
 * canonical-key passthrough); deterministic, no mocks or harnesses.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../types";
import {
	checkRequiredSecrets,
	getValidationPattern,
	hasValidationPattern,
	inferValidationPatternKey,
	validateActionKeywords,
	validateActionRegex,
	validateSecretKey,
	validateSecrets,
} from "./index.ts";

const memory = (text?: string) => ({ content: { text } }) as Memory;

describe("validateActionKeywords via index", () => {
	it("tolerates a missing or null recent-messages list", () => {
		expect(
			validateActionKeywords(
				memory("run the task"),
				undefined as unknown as Memory[],
				["task"],
			),
		).toBe(true);
		expect(
			validateActionKeywords(
				memory("nothing relevant here"),
				null as unknown as Memory[],
				["task"],
			),
		).toBe(false);
	});

	it("matches a keyword found only in retained history", () => {
		const recent = [memory("please review"), memory("the deployment")];
		expect(
			validateActionKeywords(memory("current"), recent, ["deployment"]),
		).toBe(true);
	});

	it("does not match a phrase spanning the newline join between messages", () => {
		const recent = [memory("please review"), memory("the deployment")];
		expect(
			validateActionKeywords(memory("current"), recent, ["review the"]),
		).toBe(false);
	});
});

describe("validateActionRegex via index", () => {
	it("scans the joined history and preserves caller-supplied flags", () => {
		expect(
			validateActionRegex(memory("Say HELLO WORLD"), [], /hello world/i),
		).toBe(true);
		expect(
			validateActionRegex(
				memory("first"),
				[memory("second"), memory("third")],
				/^second$/m,
			),
		).toBe(true);
	});

	it("returns false when no message carries text", () => {
		expect(validateActionRegex(memory(), [], /anything/)).toBe(false);
	});
});

describe("validateSecretKey via index", () => {
	it("rejects below-minimum lengths before evaluating the pattern", () => {
		const short = validateSecretKey("OPENAI_API_KEY", "sk-short");
		expect(short.isValid).toBe(false);
		expect(short.error).toBe(
			"OPENAI_API_KEY is too short (minimum 20 characters)",
		);
	});

	it("rejects above-maximum lengths even when the prefix looks right", () => {
		const long = validateSecretKey("ELEVENLABS_API_KEY", "a".repeat(40));
		expect(long.isValid).toBe(false);
		expect(long.error).toBe(
			"ELEVENLABS_API_KEY is too long (maximum 32 characters)",
		);
	});

	it("accepts well-formed connection strings and rejects other schemes", () => {
		expect(
			validateSecretKey(
				"DATABASE_URL",
				"postgresql://user:pass@localhost:5432/db",
			).isValid,
		).toBe(true);
		const bad = validateSecretKey("DATABASE_URL", "ftp://nope.invalid");
		expect(bad.isValid).toBe(false);
		expect(bad.error).toBe("Database URL must be a valid connection string");
	});

	it("applies basic checks to keys without a dedicated pattern", () => {
		expect(validateSecretKey("CUSTOM_THING", "   ").error).toBe(
			"Secret value cannot be empty",
		);

		const placeholder = validateSecretKey("CUSTOM_THING", "set-xxx-in-env");
		expect(placeholder.isValid).toBe(false);
		expect(placeholder.error).toBe("Secret appears to be a placeholder value");

		const shortButUsable = validateSecretKey("CUSTOM_THING", "tiny");
		expect(shortButUsable.isValid).toBe(true);
		expect(shortButUsable.warning).toBe("Secret value seems unusually short");
	});
});

describe("batch and lookup helpers via index", () => {
	it("validates each entry independently in the map form", () => {
		const results = validateSecrets({
			OK_KEY: "a-solid-value-here",
			BAD_KEY: "",
		});
		expect(results.OK_KEY.isValid).toBe(true);
		expect(results.BAD_KEY.isValid).toBe(false);
	});

	it("treats empty-string values as missing and empty requirements as met", () => {
		const out = checkRequiredSecrets({ PRESENT: "" }, ["PRESENT"]);
		expect(out.missing).toEqual(["PRESENT"]);
		expect(out.valid).toBe(false);
		expect(checkRequiredSecrets({}, []).valid).toBe(true);
	});

	it("exposes pattern lookups for known and unknown keys", () => {
		expect(hasValidationPattern("SLACK_APP_TOKEN")).toBe(true);
		expect(hasValidationPattern("NOT_A_REAL_KEY")).toBe(false);
		expect(getValidationPattern("TWITTER_2FA_SECRET")?.maxLength).toBe(32);
		expect(getValidationPattern("NOT_A_REAL_KEY")).toBeUndefined();
	});

	it("maps variant names to canonical patterns and passes others through", () => {
		expect(inferValidationPatternKey("slack_app")).toBe("SLACK_APP_TOKEN");
		expect(inferValidationPatternKey("MY_DISCORD_TOKEN")).toBe(
			"DISCORD_BOT_TOKEN",
		);
		expect(inferValidationPatternKey("totally_custom")).toBe("totally_custom");
	});
});
