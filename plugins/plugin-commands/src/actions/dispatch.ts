/**
 * Command dispatch — the one entry point that turns a slash-command message
 * into a deterministic reply. Reused by:
 *   - the agent's command actions (the registered `*_COMMAND` actions),
 *   - the pre-LLM shortcut gate (slash commands are always-on shortcuts), and
 *   - connector bridges that want an instant local reply.
 *
 * It detects + parses the command, builds a `CommandContext`, runs `runCommand`,
 * and (when the command was handled) fires the callback with the reply. Returns
 * whether it owned the message, so callers can fall through to the normal
 * pipeline when it didn't.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { detectCommand, hasCommand } from "../parser";
import { findCommandByKey, useRuntime } from "../registry";
import type { CommandContext, ParsedCommand } from "../types";
import { isGateSafeCommand, runCommand } from "./handlers";

export interface CommandDispatchOptions {
	/**
	 * Trust level for the sender, used to gate `requiresAuth`/`requiresElevated`
	 * commands. The caller knows the surface: the local dashboard/TUI sender is
	 * the owner (authorized + elevated); a connector resolves it from pairing /
	 * allowlist. Defaults to unauthorized so a missing resolver fails closed.
	 */
	isAuthorized?: boolean;
	isElevated?: boolean;
	senderName?: string;
	/**
	 * When true (the default), only commands whose entire effect is their reply
	 * are dispatched; lifecycle/management commands fall through to the pipeline
	 * that owns their side effects.
	 */
	gateSafeOnly?: boolean;
}

/** What a successful dispatch resolved to. */
export interface CommandDispatchResult {
	handled: boolean;
	reply?: string;
	command?: ParsedCommand;
}

function buildContext(
	message: Memory,
	options: CommandDispatchOptions,
): CommandContext {
	const content = message.content as {
		channelId?: string;
		source?: string;
	};
	const context: CommandContext = {
		senderId: message.entityId,
		isAuthorized: options.isAuthorized ?? false,
		isElevated: options.isElevated ?? false,
		roomId: message.roomId,
	};
	if (options.senderName) context.senderName = options.senderName;
	const channelId = content.channelId ?? content.source;
	if (channelId) context.channelId = channelId;
	return context;
}

/**
 * Detect, parse, and deterministically run a slash command. Does NOT fire a
 * callback — returns the result so the caller controls how to surface the reply.
 */
export async function resolveCommand(
	runtime: IAgentRuntime,
	message: Memory,
	options: CommandDispatchOptions = {},
): Promise<CommandDispatchResult> {
	useRuntime(runtime.agentId);
	const text = message.content.text ?? "";
	if (!hasCommand(text)) return { handled: false };

	const detection = detectCommand(text);
	if (!detection.isCommand || !detection.command) return { handled: false };

	const parsed = detection.command;
	const definition = findCommandByKey(parsed.key);
	// Only agent-target commands are dispatched here; navigate/client targets are
	// resolved by the client/connector, never the agent.
	if (definition?.target && definition.target.kind !== "agent") {
		return { handled: false, command: parsed };
	}
	const gateSafeOnly = options.gateSafeOnly ?? true;
	if (gateSafeOnly && !isGateSafeCommand(parsed.key)) {
		return { handled: false, command: parsed };
	}

	const result = await runCommand(
		runtime,
		parsed,
		buildContext(message, options),
	);
	if (!result.handled) return { handled: false, command: parsed };
	const dispatched: CommandDispatchResult = { handled: true, command: parsed };
	if (result.reply !== undefined) dispatched.reply = result.reply;
	return dispatched;
}

/**
 * Resolve a command and, when handled, fire `callback` with the reply. Returns
 * true when the command was handled (so the caller skips the LLM pipeline).
 */
export async function dispatchCommandMessage(
	runtime: IAgentRuntime,
	message: Memory,
	callback: (reply: { text: string; source?: string }) => unknown,
	options: CommandDispatchOptions = {},
): Promise<boolean> {
	const result = await resolveCommand(runtime, message, options);
	if (!result.handled || result.reply === undefined) return false;
	await callback({ text: result.reply, source: "command" });
	return true;
}
