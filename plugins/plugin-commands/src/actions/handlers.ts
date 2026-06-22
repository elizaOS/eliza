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
import { type CommandSettings, getCommandSettings } from "./command-settings";

/**
 * Commands whose entire effect is the reply `runCommand` produces — safe to
 * short-circuit before the LLM. Lifecycle/management commands (reset, new,
 * compact, stop, restart, allowlist, …) and runtime option commands (think,
 * model, tts, elevated, …) have side effects owned by the existing pipeline and
 * must flow through it, so they are intentionally excluded from the always-on
 * gate.
 */
export const GATE_SAFE_COMMAND_KEYS: readonly string[] = [
	"help",
	"commands",
	"status",
	"whoami",
	"context",
	"models",
	"usage",
];

const GATE_SAFE_KEYS: ReadonlySet<string> = new Set(GATE_SAFE_COMMAND_KEYS);

/** Whether a command's whole effect is its deterministic reply (gate-safe). */
export function isGateSafeCommand(key: string): boolean {
	return GATE_SAFE_KEYS.has(key);
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
			const lines = [
				`Agent: ${runtime.character?.name ?? runtime.agentId}`,
				`Model: ${settings.model ?? resolveModelLabel(runtime)}`,
				`Thinking: ${settings.thinking ?? "default"}`,
				`Reasoning: ${settings.reasoning ?? "default"}`,
				`Verbose: ${settings.verbose ?? "default"}`,
				`Commands enabled: ${getEnabledCommandsForRuntime(agentId).length}`,
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
			if (!usage?.totalTokens) {
				return reply("No token usage recorded for this conversation yet.");
			}
			return reply(
				`Token usage — prompt: ${usage.promptTokens ?? 0}, completion: ${usage.completionTokens ?? 0}, total: ${usage.totalTokens}.`,
			);
		}

		default:
			// Not a gate-safe command this layer owns — let it flow to the pipeline.
			return { handled: false, shouldContinue: true };
	}
}

function describeSettings(settings: CommandSettings): string {
	const entries = Object.entries(settings).filter(([, v]) => v);
	if (entries.length === 0) return "none";
	return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}
