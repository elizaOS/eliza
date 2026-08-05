/** Proves ordinary command questions remain model-owned while slash commands retain protocol dispatch. */

import { matchShortcut } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	commandShortcuts,
	explicitCommandShortcuts,
} from "../src/actions/shortcuts";

const COMMANDS_ACTIONS = ["COMMANDS_COMMAND", "HELP_COMMAND"];
const NL = { allowNatural: true, actions: COMMANDS_ACTIONS } as const;

describe("command shortcut ownership", () => {
	it("registers explicit protocol shortcuts only", () => {
		expect(commandShortcuts).toEqual(explicitCommandShortcuts);
		expect(
			commandShortcuts.every((shortcut) => shortcut.kind === "explicit"),
		).toBe(true);
	});

	it("keeps natural command questions on the model path", () => {
		for (const phrase of [
			"list the commands",
			"list available commands",
			"show me a list of commands",
			"what are the commands",
			"what are all the available commands",
			"what commands do you have",
		]) {
			expect(matchShortcut(commandShortcuts, phrase, NL), phrase).toBeNull();
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
