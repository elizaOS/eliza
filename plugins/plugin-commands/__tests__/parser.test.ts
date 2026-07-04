/**
 * Unit tests for the command parser: body normalization (whitespace, bot-mention
 * stripping, colon separators) and `parseCommand` token/argument extraction.
 */
import { describe, expect, it } from "vitest";
import { normalizeCommandBody, parseCommand } from "../src/parser.ts";
import type { CommandDefinition } from "../src/types.ts";

/**
 * First tests for the slash-command parser (#8801 / #9943 — plugin-commands
 * shipped with zero tests). Covers alias matching, the colon form, quoted /
 * capture-remaining args, and the parsing modes — the logic every connector
 * surface relies on to turn a chat line into a command.
 */
function define(
	overrides: Partial<CommandDefinition> &
		Pick<CommandDefinition, "key" | "textAliases">,
): CommandDefinition {
	return { description: "test command", scope: "both", ...overrides };
}

describe("normalizeCommandBody", () => {
	it("trims surrounding whitespace", () => {
		expect(normalizeCommandBody("  /status  ")).toBe("/status");
	});

	it("strips a leading bot mention, case-insensitively", () => {
		expect(normalizeCommandBody("@Bot  /status", "bot")).toBe("/status");
	});

	it("rewrites a colon command separator to a space", () => {
		expect(normalizeCommandBody("/think: high")).toBe("/think high");
		expect(normalizeCommandBody("!mode:fast")).toBe("!mode fast");
	});

	it("leaves a plain command body untouched", () => {
		expect(normalizeCommandBody("/help me now")).toBe("/help me now");
	});
});

describe("parseCommand", () => {
	const think = define({
		key: "think",
		textAliases: ["/think"],
		acceptsArgs: true,
		argsParsing: "positional",
		args: [],
	});

	it("returns null when no alias matches", () => {
		expect(parseCommand("/status", think)).toBeNull();
		// a strict prefix that is not followed by space/colon is NOT a match
		expect(parseCommand("/thinking", think)).toBeNull();
	});

	it("matches an exact alias with no args", () => {
		const parsed = parseCommand("/think", think);
		expect(parsed?.key).toBe("think");
		expect(parsed?.canonical).toBe("/think");
		expect(parsed?.args).toEqual([]);
	});

	it("matches case-insensitively", () => {
		expect(parseCommand("/THINK", think)?.key).toBe("think");
	});

	it("parses the colon form (/think:high)", () => {
		expect(parseCommand("/think:high", think)?.args).toEqual(["high"]);
	});

	it("tokenizes positional args, respecting quotes", () => {
		expect(parseCommand('/think "two words" solo', think)?.args).toEqual([
			"two words",
			"solo",
		]);
	});

	it("captureRemaining joins the rest into a single arg", () => {
		const say = define({
			key: "say",
			textAliases: ["/say"],
			acceptsArgs: true,
			argsParsing: "positional",
			args: [{ name: "message", description: "", captureRemaining: true }],
		});
		expect(parseCommand("/say hello there world", say)?.args).toEqual([
			"hello there world",
		]);
	});

	it("argsParsing 'none' returns the whole remainder as one arg", () => {
		const raw = define({
			key: "raw",
			textAliases: ["/raw"],
			acceptsArgs: true,
			argsParsing: "none",
		});
		expect(parseCommand("/raw a b c", raw)?.args).toEqual(["a b c"]);
	});

	it("returns empty args when the command does not accept args", () => {
		const ping = define({
			key: "ping",
			textAliases: ["/ping"],
			acceptsArgs: false,
		});
		expect(parseCommand("/ping ignored", ping)?.args).toEqual([]);
	});

	it("uses the first alias as the canonical form", () => {
		const help = define({ key: "help", textAliases: ["/help", "/h", "/?"] });
		expect(parseCommand("/h", help)?.canonical).toBe("/help");
	});
});
