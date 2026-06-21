/**
 * Slash-command shortcuts (#8790 × #8791).
 *
 * Each gate-safe agent-target command is registered as an *explicit* shortcut
 * into the runtime's `ShortcutRegistry`. The pre-LLM gate matches the slash/`!`
 * alias and fires the command's `*_COMMAND` action directly — so `/help`,
 * `/status`, `/think high`, … resolve deterministically before any model call,
 * identically on every surface. Explicit shortcuts are always-on (a slash is an
 * unambiguous invocation); they carry no auth flag here because the command
 * action re-checks sender trust itself.
 */

import type { ShortcutDefinition } from "@elizaos/core";
import { findCommandByKey } from "../registry";
import { GATE_SAFE_COMMAND_KEYS } from "./handlers";

/**
 * Build the explicit slash-command shortcuts for the built-in gate-safe
 * commands, from the default registry. Built once at module load; each
 * shortcut targets the matching `<KEY>_COMMAND` action.
 */
export function createCommandShortcuts(
	commandKeys: readonly string[] = GATE_SAFE_COMMAND_KEYS,
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

/** The explicit slash-command shortcuts for the built-in gate-safe commands. */
export const commandShortcuts: ShortcutDefinition[] = createCommandShortcuts();
