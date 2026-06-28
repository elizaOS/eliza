/**
 * Slash-command shortcuts (#8790 × #8791).
 *
 * Each deterministic agent-target command is registered as an *explicit* shortcut
 * into the runtime's `ShortcutRegistry`. The pre-LLM gate matches the slash/`!`
 * alias and fires the command's `*_COMMAND` action directly — so `/help`,
 * `/status`, `/models`, … resolve deterministically before any model call,
 * identically on every surface. Explicit shortcuts are always-on (a slash is an
 * unambiguous invocation); they carry no auth flag here because the command
 * action re-checks sender trust itself.
 */

import type { ShortcutDefinition } from "@elizaos/core";
import { findCommandByKey } from "../registry";
import { DETERMINISTIC_COMMAND_KEYS } from "./handlers";

/**
 * Build the explicit slash-command shortcuts for the built-in deterministic
 * commands, from the default registry. Built once at module load; each
 * shortcut targets the matching `<KEY>_COMMAND` action.
 */
export function createCommandShortcuts(
	commandKeys: readonly string[] = DETERMINISTIC_COMMAND_KEYS,
): ShortcutDefinition[] {
	const shortcuts: ShortcutDefinition[] = [];
	for (const key of commandKeys) {
		const definition = findCommandByKey(key);
		if (!definition) continue;
		if (definition.target && definition.target.kind !== "agent") continue;
		shortcuts.push({
			id: `cmd:${key}`,
			kind: "explicit",
			aliases: definition.textAliases,
			target: { kind: "action", name: `${key.toUpperCase()}_COMMAND` },
		});
	}
	return shortcuts;
}

/** The explicit slash-command shortcuts for built-in deterministic commands. */
export const explicitCommandShortcuts: ShortcutDefinition[] =
	createCommandShortcuts();

/**
 * Natural-language shortcuts (#8791 C6).
 *
 * These are narrow, anchored, and confidence-floored. Each one targets an
 * UNAMBIGUOUS deterministic intent that maps onto a deterministic `*_COMMAND`
 * action, so the pre-LLM gate can fire it with zero inference.
 *
 * The sole production shortcut here is "what commands can I use" / "show me the
 * commands" / "list the available commands" → `COMMANDS_COMMAND`. The patterns
 * are anchored (`^…$`) over ASR-normalized text and require both a list/show
 * verb and the literal word "commands", so a conversational message like "can
 * you help me with this command line" never matches — it lacks the anchored
 * verb+"commands" shape and falls through to the LLM.
 */
export const naturalShortcuts: ShortcutDefinition[] = [
	{
		id: "nl:commands",
		kind: "natural",
		patterns: [
			// "what commands can i use", "what commands are available", "what commands do you have"
			{
				regex:
					/^what commands (?:can i (?:use|run)|are (?:there|available)|do you (?:have|support))$/u,
			},
			// "show/list/give me the commands", "show me a list of commands",
			// "list available commands", "list all the commands", "what are the commands"
			{
				regex:
					/^(?:show|list|give|tell)(?: me)?(?: a list of| the list of| all(?: of)?| the| your| available)* commands$/u,
			},
			{ regex: /^what are(?: all)?(?: the| your| available)* commands$/u },
		],
		target: { kind: "action", name: "COMMANDS_COMMAND" },
		requiresAction: "COMMANDS_COMMAND",
		confidence: 0.95,
	},
];

/**
 * All command shortcuts the plugin registers: the explicit slash-command
 * shortcuts plus the narrow natural-language shortcuts.
 */
export const commandShortcuts: ShortcutDefinition[] = [
	...explicitCommandShortcuts,
	...naturalShortcuts,
];
