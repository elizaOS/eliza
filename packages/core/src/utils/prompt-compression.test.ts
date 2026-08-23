/**
 * Unit tests for the prompt-compression entrypoint in
 * packages/core/src/utils/prompt-compression.ts.
 *
 * The file is a one-symbol re-export barrel of `compressPromptDescription`
 * from `@elizaos/prompts`; these tests import through that path (the same
 * specifier production uses) and drive the real compressor with no mocks.
 * Coverage: empty/non-string guards, protected-span masking (code fences,
 * inline code, URLs, file paths, SCREAMING_CASE identifiers), filler phrase
 * and word compaction, leading-verb normalization, punctuation tightening,
 * and completeness of long output (no length cap or tail truncation).
 */

import { compressPromptDescription as compressPromptDescriptionFromPrompts } from "@elizaos/prompts";
import { describe, expect, it } from "vitest";
import { compressPromptDescription } from "./prompt-compression";

describe("prompt-compression entrypoint", () => {
	it("re-exports the same compressor function as @elizaos/prompts", () => {
		expect(typeof compressPromptDescription).toBe("function");
		expect(compressPromptDescription).toBe(
			compressPromptDescriptionFromPrompts,
		);
	});
});

describe("compressPromptDescription: empty and non-string guards", () => {
	it("returns an empty string for undefined", () => {
		expect(compressPromptDescription(undefined)).toBe("");
	});

	it("returns an empty string for an empty string input", () => {
		expect(compressPromptDescription("")).toBe("");
	});

	it("returns an empty string for whitespace-only input", () => {
		expect(compressPromptDescription("   \n\t  ")).toBe("");
	});
});

describe("compressPromptDescription: whitespace and markdown normalization", () => {
	it("collapses runs of internal whitespace", () => {
		expect(
			compressPromptDescription("Spaced    out\t\ttext\n\nwith   gaps."),
		).toBe("Spaced out text with gaps.");
	});

	it("strips bold markers while keeping the enclosed words", () => {
		expect(compressPromptDescription("**Bold** intro text.")).toBe(
			"Bold intro text.",
		);
	});

	it("normalizes spaced em and en dashes to spaced hyphens", () => {
		expect(
			compressPromptDescription(
				"First part — second part – third part - fourth.",
			),
		).toBe("First part - second part - third part - fourth.");
	});

	it("rewrites unspaced en dashes to plain hyphens inside words", () => {
		expect(compressPromptDescription("state–of–the–art design")).toBe(
			"state-of-the-art design",
		);
	});

	it("converts semicolons into sentence periods", () => {
		expect(compressPromptDescription("One thing; another thing; third.")).toBe(
			"One thing. another thing. third.",
		);
	});
});

describe("compressPromptDescription: punctuation tightening", () => {
	it("removes spaces before terminal punctuation", () => {
		expect(compressPromptDescription("Trailing space before period .")).toBe(
			"Trailing space before period.",
		);
	});

	it("collapses repeated sentence punctuation to a single mark", () => {
		expect(compressPromptDescription("Repeated dots here... Really?!?")).toBe(
			"Repeated dots here. Really?",
		);
	});

	it("tightens spacing inside parentheses", () => {
		expect(compressPromptDescription("Paren ( spacing ) test")).toBe(
			"Paren (spacing) test",
		);
	});

	it("removes spaces around slashes", () => {
		expect(compressPromptDescription("and / or / maybe")).toBe("and/or/maybe");
	});

	it("normalizes comma spacing only where space already exists", () => {
		expect(compressPromptDescription("one,two, three , four")).toBe(
			"one,two, three, four",
		);
	});
});

describe("compressPromptDescription: filler phrase removal", () => {
	it("rewrites 'in order to' to 'to' and then compacts the 'use this' frame around it", () => {
		expect(
			compressPromptDescription("Use this in order to compress text."),
		).toBe("Use to compress text.");
	});

	it("drops standalone filler adverbs anywhere in the text", () => {
		expect(
			compressPromptDescription(
				"Please simply basically actually currently run the task.",
			),
		).toBe("run the task.");
	});

	it("compacts 'the user' and 'the agent' to bare nouns", () => {
		expect(
			compressPromptDescription(
				"Notifies the user and the agent about new responses.",
			),
		).toBe("Notifies user and agent about new replies.");
	});
});

describe("compressPromptDescription: word substitutions", () => {
	it("abbreviates common technical nouns", () => {
		expect(
			compressPromptDescription(
				"Stores information about messages, parameters, identifiers and applications in the database.",
			),
		).toBe("Stores info about msgs, params, ids and apps in the DB.");
	});

	it("keeps plural forms distinct from singular substitutions", () => {
		expect(compressPromptDescription("One message, many messages.")).toBe(
			"One msg, many msgs.",
		);
	});

	it("abbreviates quantity adverbs", () => {
		expect(
			compressPromptDescription(
				"Allows approximately 10 items, maximum 20, minimum 5.",
			),
		).toBe("Allows approx. 10 items, max 20, min 5.");
	});
});

describe("compressPromptDescription: leading verb normalization", () => {
	it("rewrites third-person lead verbs to imperatives", () => {
		expect(compressPromptDescription("Provides access to messages.")).toBe(
			"Provide access to msgs.",
		);
		expect(compressPromptDescription("Retrieves messages for the user.")).toBe(
			"Get msgs for user.",
		);
		expect(compressPromptDescription("Returns a response quickly.")).toBe(
			"Return a reply quickly.",
		);
	});

	it("rewrites only the leading occurrence of each pattern", () => {
		expect(compressPromptDescription("Automatically sends messages.")).toBe(
			"Auto sends msgs.",
		);
	});
});

describe("compressPromptDescription: protected spans survive verbatim", () => {
	it("preserves inline code spans that contain removable filler and substitutable words", () => {
		expect(
			compressPromptDescription(
				"Run `npm install please` to get the maximum message.",
			),
		).toBe("Run `npm install please` to get the max msg.");
	});

	it("preserves URLs including text that would otherwise be rewritten", () => {
		expect(
			compressPromptDescription(
				"See https://example.com/docs-in-order-to-learn for details.",
			),
		).toBe("See https://example.com/docs-in-order-to-learn for details.");
	});

	it("preserves file paths containing phrase-replacement targets", () => {
		expect(
			compressPromptDescription("Tails /the/user/messages.log daily."),
		).toBe("Tails /the/user/messages.log daily.");
		expect(
			compressPromptDescription(
				"Reads ~/.config/eliza/settings.json and ./local/file.json.",
			),
		).toBe("Reads ~/.config/eliza/settings.json and ./local/file.json.");
	});

	it("preserves SCREAMING_CASE identifiers against word substitution", () => {
		expect(
			compressPromptDescription(
				"Set MAX_MESSAGES before running the migration.",
			),
		).toBe("Set MAX_MESSAGES before running the migration.");
	});

	it("preserves fenced code blocks byte-for-byte across whitespace normalization", () => {
		const description =
			"Example:\n```\nconst x =    1;\nplease keep   this\n```\nDone.";
		expect(compressPromptDescription(description)).toBe(
			"Example: ```\nconst x =    1;\nplease keep   this\n``` Done.",
		);
	});

	it("returns a lone fenced block unchanged", () => {
		expect(compressPromptDescription("```\n```\n")).toBe("```\n```");
	});
});

describe("compressPromptDescription: integration and completeness", () => {
	it("applies protection, compaction, and tightening together to an action description", () => {
		expect(
			compressPromptDescription(
				"This action will send a message to the user when the user asks to transfer funds.",
			),
		).toBe("send a msg to user when user asks to transfer funds.");
	});

	it("compresses a full catalog-style description end to end", () => {
		expect(
			compressPromptDescription(
				"Provides search over the user's messages. Use this action when the user wants to find conversations; supports filtering by date range.",
			),
		).toBe(
			"Provide search over user's msgs. Use when user wants to find convos. supports filtering by date range.",
		);
	});

	it("is deterministic across repeated calls", () => {
		const description =
			"Provides information about **messages**; see https://example.com/a for details.";
		const first = compressPromptDescription(description);
		const second = compressPromptDescription(description);
		expect(second).toBe(first);
	});

	it("emits the complete compressed text without any length cap or tail truncation", () => {
		const count = 200;
		const description = Array<string>(count).fill("message").join(" ");
		const expected = Array<string>(count).fill("msg").join(" ");
		expect(compressPromptDescription(description)).toBe(expected);
	});
});
