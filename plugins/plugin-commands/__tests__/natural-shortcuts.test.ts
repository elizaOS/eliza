/**
 * Natural-language command shortcuts (#8791 C6).
 *
 * Proves the production natural shortcut for "show me the commands" resolves to
 * `COMMANDS_COMMAND` through the core matcher — including an ASR-normalized,
 * punctuation-free variant — while ambiguous/low-signal input and the default
 * `allowNatural: false` path return `null` (so DEFAULT behavior is unchanged).
 */

import { matchShortcut } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	commandShortcuts,
	explicitCommandShortcuts,
	naturalShortcuts,
} from "../src/actions/shortcuts";

const COMMANDS_ACTIONS = ["COMMANDS_COMMAND", "HELP_COMMAND"];
const NL = { allowNatural: true, actions: COMMANDS_ACTIONS } as const;

describe("naturalShortcuts (#8791 C6)", () => {
	it("declares exactly the deterministic COMMANDS natural shortcut", () => {
		expect(naturalShortcuts).toHaveLength(1);
		const def = naturalShortcuts[0];
		expect(def?.kind).toBe("natural");
		expect(def?.target).toEqual({ kind: "action", name: "COMMANDS_COMMAND" });
		expect(def?.requiresAction).toBe("COMMANDS_COMMAND");
		expect(def?.confidence ?? 0).toBeGreaterThanOrEqual(0.9);
	});

	it("is appended to the explicit shortcuts in commandShortcuts", () => {
		expect(commandShortcuts).toEqual([
			...explicitCommandShortcuts,
			...naturalShortcuts,
		]);
		// The explicit shortcuts must remain explicit-only (no natural leakage).
		expect(explicitCommandShortcuts.every((s) => s.kind === "explicit")).toBe(
			true,
		);
	});

	it("resolves a natural phrase to COMMANDS_COMMAND with confidence", () => {
		const m = matchShortcut(commandShortcuts, "show me the commands", NL);
		expect(m?.shortcut.id).toBe("nl:commands");
		expect(m?.shortcut.target).toEqual({
			kind: "action",
			name: "COMMANDS_COMMAND",
		});
		expect(m?.confidence).toBeGreaterThanOrEqual(0.9);
	});

	it("resolves the ASR-normalized, punctuation-free variant", () => {
		// What an ASR transcript yields: capitalization + trailing punctuation,
		// all stripped by normalizeForMatch.
		const asr = "What commands can I use?";
		const m = matchShortcut(commandShortcuts, asr, NL);
		expect(m?.shortcut.id).toBe("nl:commands");
		expect(m?.shortcut.target).toEqual({
			kind: "action",
			name: "COMMANDS_COMMAND",
		});
	});

	it("matches several deterministic phrasings", () => {
		for (const phrase of [
			"list the commands",
			"list available commands",
			"show me a list of commands",
			"what are the commands",
			"what are all the available commands",
			"what commands do you have",
		]) {
			expect(
				matchShortcut(commandShortcuts, phrase, NL)?.shortcut.id,
				`expected "${phrase}" to match`,
			).toBe("nl:commands");
		}
	});

	it("returns null for ambiguous / conversational input", () => {
		for (const phrase of [
			"can you help me with this command line",
			"i ran a command and it failed",
			"what should i do next",
			"tell me about the weather",
			"command",
		]) {
			expect(
				matchShortcut(commandShortcuts, phrase, NL),
				`expected "${phrase}" not to match`,
			).toBeNull();
		}
	});

	it("does NOT match natural phrases when allowNatural is false (default-off safety)", () => {
		expect(
			matchShortcut(commandShortcuts, "show me the commands", {
				allowNatural: false,
				actions: COMMANDS_ACTIONS,
			}),
		).toBeNull();
		// Default context (allowNatural omitted) is also off.
		expect(
			matchShortcut(commandShortcuts, "show me the commands", {
				actions: COMMANDS_ACTIONS,
			}),
		).toBeNull();
	});

	it("skips the shortcut when its target action is not registered", () => {
		expect(
			matchShortcut(commandShortcuts, "show me the commands", {
				allowNatural: true,
				actions: ["HELP_COMMAND"],
			}),
		).toBeNull();
	});

	it("still matches an explicit slash command regardless of the flag", () => {
		const m = matchShortcut(commandShortcuts, "/commands", {
			allowNatural: false,
			actions: COMMANDS_ACTIONS,
		});
		expect(m?.shortcut.target).toEqual({
			kind: "action",
			name: "COMMANDS_COMMAND",
		});
	});
});
