/**
 * Deterministic command handlers.
 *
 * `runCommand` is the single source of truth for what an agent-target command
 * does. It reads real runtime/registry state, persists option settings, invokes
 * owned runtime actions when needed, and returns a deterministic
 * `CommandResult`. No LLM improvisation: the same command path runs on web,
 * TUI, Discord, and Telegram. This is the agent-target action layer #8790 asks
 * for.
 */

import type {
	Action,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	UUID,
} from "@elizaos/core";
import {
	findCommandByKeyForRuntime,
	getCommandsByCategoryForRuntime,
	getEnabledCommandsForRuntime,
	useRuntime,
} from "../registry";
import type {
	CommandCategory,
	CommandContext,
	CommandResult,
	ParsedCommand,
} from "../types";
import {
	clearCommandSettings,
	type CommandSettings,
	getCommandSettings,
	setCommandSetting,
} from "./command-settings";

/**
 * Commands whose effects are fully owned by this deterministic layer. Broader
 * lifecycle/management commands (`stop`, `restart`, `allowlist`, `approve`, …)
 * still flow through the pipeline that owns their side effects.
 */
export const DETERMINISTIC_COMMAND_KEYS: readonly string[] = [
	"help",
	"commands",
	"status",
	"whoami",
	"context",
	"reset",
	"new",
	"compact",
	"models",
	"usage",
	"think",
	"verbose",
	"reasoning",
	"queue",
	"elevated",
	"model",
	"tts",
];

/**
 * Back-compat export for callers compiled against the original name. It now
 * means the deterministic command set.
 */
export const GATE_SAFE_COMMAND_KEYS = DETERMINISTIC_COMMAND_KEYS;

const DETERMINISTIC_KEYS: ReadonlySet<string> = new Set(
	DETERMINISTIC_COMMAND_KEYS,
);

/** Whether a command's whole effect is handled by this deterministic layer. */
export function isDeterministicCommand(key: string): boolean {
	return DETERMINISTIC_KEYS.has(key);
}

/** @deprecated Use `isDeterministicCommand`. */
export function isGateSafeCommand(key: string): boolean {
	return isDeterministicCommand(key);
}

const CATEGORY_ORDER: CommandCategory[] = [
	"status",
	"session",
	"options",
	"media",
	"management",
	"tools",
	"docks",
	"skills",
];

const OPTION_COMMANDS = {
	think: { key: "thinking", label: "Thinking" },
	verbose: { key: "verbose", label: "Verbose" },
	reasoning: { key: "reasoning", label: "Reasoning" },
	queue: { key: "queue", label: "Queue mode" },
	elevated: { key: "elevated", label: "Elevated mode" },
	model: { key: "model", label: "Model" },
	tts: { key: "tts", label: "TTS" },
} as const satisfies Record<
	string,
	{ key: keyof CommandSettings; label: string }
>;

function reply(text: string): CommandResult {
	return { handled: true, reply: text, shouldContinue: false };
}

function authError(): CommandResult {
	return reply("This command requires authorization.");
}

function formatCommandList(agentId?: string | null): string {
	const lines: string[] = [];
	for (const category of CATEGORY_ORDER) {
		const commands = getCommandsByCategoryForRuntime(category, agentId);
		if (commands.length === 0) continue;
		lines.push(`**${category}**`);
		for (const command of commands) {
			const alias = command.textAliases[0] ?? `/${command.key}`;
			const auth = command.requiresAuth ? " (requires auth)" : "";
			lines.push(`  ${alias} — ${command.description}${auth}`);
		}
	}
	return lines.join("\n");
}

function resolveModelLabel(runtime: IAgentRuntime): string {
	const fromSetting =
		runtime.getSetting("LARGE_MODEL") ??
		runtime.getSetting("ANTHROPIC_LARGE_MODEL") ??
		runtime.getSetting("OPENAI_LARGE_MODEL");
	if (typeof fromSetting === "string" && fromSetting.trim()) {
		return fromSetting.trim();
	}
	const fromCharacter = (
		runtime.character?.settings as Record<string, unknown> | undefined
	)?.model;
	if (typeof fromCharacter === "string" && fromCharacter.trim()) {
		return fromCharacter.trim();
	}
	return "default";
}

async function countRoomMessages(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<number | null> {
	if (typeof runtime.countMemories !== "function") return null;
	try {
		return await runtime.countMemories({
			roomIds: [roomId as UUID],
			tableName: "messages",
			unique: false,
		});
	} catch {
		return null;
	}
}

async function clearRoomMessages(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<number | null> {
	const before = await countRoomMessages(runtime, roomId);
	if (typeof runtime.deleteAllMemories !== "function") return null;
	await runtime.deleteAllMemories([roomId as UUID], "messages");
	return before;
}

function findAction(runtime: IAgentRuntime, name: string): Action | undefined {
	return runtime.actions?.find((action) => action.name === name);
}

async function runCompactAction(
	runtime: IAgentRuntime,
	message: Memory | undefined,
	callback?: HandlerCallback,
): Promise<CommandResult> {
	const action = findAction(runtime, "COMPACT_CONVERSATION");
	if (!action || !message) {
		return reply("Conversation compaction is not available in this runtime.");
	}

	const result = await action.handler(
		runtime,
		message,
		undefined,
		undefined,
		callback,
	);
	if (result?.text && result.text.trim().length > 0) {
		return reply(result.text);
	}
	return reply("Conversation compaction completed.");
}

async function setOptionCommand(
	runtime: IAgentRuntime,
	roomId: string,
	parsed: ParsedCommand,
	option: { key: keyof CommandSettings; label: string },
): Promise<CommandResult> {
	const rawValue = parsed.rawArgs?.trim() ?? parsed.args[0]?.trim() ?? "";
	if (!rawValue) {
		const settings = await getCommandSettings(runtime, roomId);
		const current =
			option.key === "model"
				? settings.model ?? resolveModelLabel(runtime)
				: settings[option.key] ?? "default";
		return reply(`${option.label} is ${current}.`);
	}

	const result = await setCommandSetting(runtime, roomId, option.key, rawValue);
	if ("error" in result) return reply(result.error);
	return reply(`${option.label} set to ${result.value}.`);
}

/**
 * Run a parsed command deterministically. Returns a `CommandResult` whose
 * `reply` is shown to the user. `handled: false` means this layer doesn't own
 * the command (the caller should let it flow to the normal pipeline).
 */
export async function runCommand(
	runtime: IAgentRuntime,
	parsed: ParsedCommand,
	context: CommandContext,
): Promise<CommandResult> {
	const agentId = runtime.agentId;
	useRuntime(agentId);
	const definition = findCommandByKeyForRuntime(parsed.key, agentId);

	// Auth gate — enforced server-side on every surface, never client-trusted.
	if (definition?.requiresAuth && !context.isAuthorized) return authError();
	if (definition?.requiresElevated && !context.isElevated) {
		return reply("This command requires elevated permissions.");
	}

	const roomId = context.roomId;

	switch (parsed.key) {
		case "help":
		case "commands":
			return reply(`Available commands:\n${formatCommandList(agentId)}`);

		case "status": {
			const settings = await getCommandSettings(runtime, roomId);
			const messageCount = await countRoomMessages(runtime, roomId);
			const lines = [
				`Agent: ${runtime.character?.name ?? runtime.agentId}`,
				`Model: ${settings.model ?? resolveModelLabel(runtime)}`,
				`Thinking: ${settings.thinking ?? "default"}`,
				`Reasoning: ${settings.reasoning ?? "default"}`,
				`Verbose: ${settings.verbose ?? "default"}`,
				`Queue: ${settings.queue ?? "default"}`,
				`TTS: ${settings.tts ?? "default"}`,
				messageCount === null ? null : `Messages: ${messageCount}`,
				`Commands enabled: ${getEnabledCommandsForRuntime(agentId).length}`,
			].filter(Boolean) as string[];
			return reply(lines.join("\n"));
		}

		case "whoami": {
			const who = context.senderName ?? context.senderId ?? "you";
			return reply(
				`You are ${who}.\nAuthorized: ${context.isAuthorized ? "yes" : "no"}\nElevated: ${context.isElevated ? "yes" : "no"}`,
			);
		}

		case "context": {
			const settings = await getCommandSettings(runtime, roomId);
			const lines = [
				`Room: ${roomId}`,
				context.channelId ? `Channel: ${context.channelId}` : null,
				`Active settings: ${describeSettings(settings)}`,
			].filter(Boolean) as string[];
			return reply(lines.join("\n"));
		}

		case "models":
			return reply(`Current model: ${resolveModelLabel(runtime)}`);

		case "usage": {
			const usage = await runtime.getCache<{
				promptTokens?: number;
				completionTokens?: number;
				totalTokens?: number;
			}>(`token-usage:${roomId}`);
			if (!usage?.totalTokens) {
				return reply("No token usage recorded for this conversation yet.");
			}
			return reply(
				`Token usage — prompt: ${usage.promptTokens ?? 0}, completion: ${usage.completionTokens ?? 0}, total: ${usage.totalTokens}.`,
			);
		}

		case "think":
		case "verbose":
		case "reasoning":
		case "queue":
		case "elevated":
		case "model":
		case "tts":
			return setOptionCommand(
				runtime,
				roomId,
				parsed,
				OPTION_COMMANDS[parsed.key],
			);

		case "reset": {
			await clearCommandSettings(runtime, roomId);
			const deleted = await clearRoomMessages(runtime, roomId);
			if (deleted === null) {
				return reply(
					"Reset command settings for this room. Message history is unchanged because memory deletion is unavailable.",
				);
			}
			return reply(
				`Reset this room: cleared command settings and ${deleted} message(s).`,
			);
		}

		case "new":
			await clearCommandSettings(runtime, roomId);
			return reply("Started a new conversation context for this room.");

		case "compact":
			return runCompactAction(runtime, context.message, context.callback);

		default:
			// Not a deterministic command this layer owns — let it flow onward.
			return { handled: false, shouldContinue: true };
	}
}

function describeSettings(settings: CommandSettings): string {
	const entries = Object.entries(settings).filter(([, v]) => v);
	if (entries.length === 0) return "none";
	return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}
