/**
 * Command actions — the registered elizaOS `Action`s for agent-target commands.
 *
 * One action per gate-safe command (`/help`, `/status`, `/whoami`, …).
 * Each action's `validate()` is strictly slash-only (it matches just its own
 * command key) and its `similes` are the slash aliases only — no natural
 * language — so the LLM never misroutes a conversational message to a command.
 * The handler delegates to the shared `resolveCommand`, so an action invoked by
 * the planner produces the exact same deterministic reply as the pre-LLM gate.
 */

import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { detectCommand, hasCommand } from "../parser";
import { findCommandByKey, useRuntime } from "../registry";
import { resolveCommand } from "./dispatch";
import { isGateSafeCommand } from "./handlers";

/** Sources that are the local owner surface (authorized + elevated). */
const OWNER_SOURCES: ReadonlySet<string> = new Set([
	"client_chat",
	"gui",
	"tui",
	"direct",
	"dashboard",
]);

/**
 * Trust for a message reaching the agent pipeline as a command action. Local
 * owner surfaces are trusted; connectors gate auth-required commands explicitly
 * via `dispatchCommandMessage` options, so a connector message stays untrusted
 * here (auth-required commands fail closed).
 */
function resolveTrust(message: Memory): {
	isAuthorized: boolean;
	isElevated: boolean;
} {
	const source = (message.content as { source?: string }).source;
	const trusted = !source || OWNER_SOURCES.has(source);
	return { isAuthorized: trusted, isElevated: trusted };
}

function buildAction(
	key: string,
	nativeName: string,
	description: string,
	aliases: string[],
): Action {
	return {
		name: `${key.toUpperCase()}_COMMAND`,
		description,
		// Slash-only similes — never natural language (prevents LLM misrouting).
		similes: aliases,
		suppressEarlyReply: true,
		suppressPostActionContinuation: true,
		validate: async (runtime: IAgentRuntime, message: Memory) => {
			useRuntime(runtime.agentId);
			const text = message.content.text ?? "";
			if (!hasCommand(text)) return false;
			const detection = detectCommand(text);
			return detection.isCommand && detection.command?.key === key;
		},
		handler: async (runtime, message, _state, _options, callback) => {
			const result = await resolveCommand(runtime, message, {
				...resolveTrust(message),
				gateSafeOnly: true,
			});
			if (!result.handled || result.reply === undefined) {
				return { success: false };
			}
			if (callback) {
				await callback({ text: result.reply, source: "command" });
			}
			return { success: true, text: result.reply };
		},
	};
}

/**
 * Build the deterministic command actions for the per-runtime registry. One
 * action per gate-safe agent-target command. Call after `useRuntime(agentId)`.
 */
export function createCommandActions(commandKeys: string[]): Action[] {
	const actions: Action[] = [];
	for (const key of commandKeys) {
		if (!isGateSafeCommand(key)) continue;
		const definition = findCommandByKey(key);
		if (!definition) continue;
		if (definition.target && definition.target.kind !== "agent") continue;
		actions.push(
			buildAction(
				key,
				definition.nativeName ?? key,
				definition.description,
				definition.textAliases,
			),
		);
	}
	return actions;
}
