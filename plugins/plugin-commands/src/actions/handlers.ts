/**
 * Deterministic command handlers.
 *
 * `runCommand` is the single source of truth for what an agent-target command
 * *does*. It is a pure-ish function over the runtime + parsed command + context:
 * it reads real runtime/registry state, persists option settings, and returns a
 * deterministic `CommandResult`. No LLM call, no improvisation — the same input
 * yields the same reply on every surface (web, TUI, Discord, Telegram). This is
 * the "agent-target action handler" layer #8790 asks for.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
	findCommandByKey,
	getCommandsByCategory,
	getEnabledCommands,
	useRuntime,
} from "../registry";
import type {
	CommandCategory,
	CommandContext,
	CommandResult,
	ParsedCommand,
} from "../types";
import {
	COMMAND_SETTING_CHOICES,
	type CommandSettings,
	getCommandSettings,
	setCommandSetting,
} from "./command-settings";

/**
 * Commands whose entire effect is the reply `runCommand` produces — safe to
 * short-circuit before the LLM. Lifecycle/management commands (reset, new,
 * compact, stop, restart, allowlist, …) have side effects owned by the existing
 * pipeline (session reset triggers, COMPACT_CONVERSATION, …) and must flow
 * through it, so they are intentionally excluded from the always-on gate.
 */
export const GATE_SAFE_COMMAND_KEYS: readonly string[] = [
	"help",
	"commands",
	"status",
	"whoami",
	"context",
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

const GATE_SAFE_KEYS: ReadonlySet<string> = new Set(GATE_SAFE_COMMAND_KEYS);

/** Whether a command's whole effect is its deterministic reply (gate-safe). */
export function isGateSafeCommand(key: string): boolean {
	return GATE_SAFE_KEYS.has(key);
}

/** Option command key → its persisted settings field. */
const SETTING_FIELD: Record<string, keyof CommandSettings> = {
	think: "thinking",
	verbose: "verbose",
	reasoning: "reasoning",
	queue: "queue",
	elevated: "elevated",
	model: "model",
	tts: "tts",
};

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

function reply(text: string): CommandResult {
	return { handled: true, reply: text, shouldContinue: false };
}

function authError(): CommandResult {
	return reply("This command requires authorization.");
}

function formatCommandList(): string {
	const lines: string[] = [];
	for (const category of CATEGORY_ORDER) {
		const commands = getCommandsByCategory(category);
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

function parseOptionArg(
	parsed: ParsedCommand,
): { kind: "show" } | { kind: "set"; value: string } {
	const arg = parsed.args[0]?.trim();
	if (!arg) return { kind: "show" };
	return { kind: "set", value: arg };
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
	useRuntime(runtime.agentId);
	const definition = findCommandByKey(parsed.key);

	// Auth gate — enforced server-side on every surface, never client-trusted.
	if (definition?.requiresAuth && !context.isAuthorized) return authError();
	if (definition?.requiresElevated && !context.isElevated) {
		return reply("This command requires elevated permissions.");
	}

	const roomId = context.roomId;

	switch (parsed.key) {
		case "help":
		case "commands":
			return reply(`Available commands:\n${formatCommandList()}`);

		case "status": {
			const settings = await getCommandSettings(runtime, roomId);
			const lines = [
				`Agent: ${runtime.character?.name ?? runtime.agentId}`,
				`Model: ${settings.model ?? resolveModelLabel(runtime)}`,
				`Thinking: ${settings.thinking ?? "default"}`,
				`Reasoning: ${settings.reasoning ?? "default"}`,
				`Verbose: ${settings.verbose ?? "default"}`,
				`Commands enabled: ${getEnabledCommands().length}`,
			];
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
			if (!usage || !usage.totalTokens) {
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
		case "tts": {
			const field = SETTING_FIELD[parsed.key];
			if (!field) return { handled: false, shouldContinue: true };
			const settings = await getCommandSettings(runtime, roomId);
			const action = parseOptionArg(parsed);
			if (action.kind === "show") {
				const current = settings[field];
				const choices = COMMAND_SETTING_CHOICES[field];
				const choiceHint = choices ? ` (options: ${choices.join(", ")})` : "";
				return reply(
					current
						? `${labelFor(parsed.key)} is ${current}.${choiceHint}`
						: `${labelFor(parsed.key)} is not set.${choiceHint}`,
				);
			}
			const result = await setCommandSetting(
				runtime,
				roomId,
				field,
				action.value,
			);
			if ("error" in result) return reply(result.error);
			return reply(`${labelFor(parsed.key)} set to ${result.value}.`);
		}

		default:
			// Not a gate-safe command this layer owns — let it flow to the pipeline.
			return { handled: false, shouldContinue: true };
	}
}

function labelFor(key: string): string {
	switch (key) {
		case "think":
			return "Thinking level";
		case "verbose":
			return "Verbose level";
		case "reasoning":
			return "Reasoning visibility";
		case "queue":
			return "Queue mode";
		case "elevated":
			return "Elevated mode";
		case "model":
			return "Model";
		case "tts":
			return "Text-to-speech";
		default:
			return key;
	}
}

function describeSettings(settings: CommandSettings): string {
	const entries = Object.entries(settings).filter(([, v]) => v);
	if (entries.length === 0) return "none";
	return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}
