/**
 * Deterministic command handlers.
 *
 * `runCommand` is the single source of truth for what an agent-target command
 * does. It reads real runtime/registry state, persists option settings, invokes
 * owned runtime actions when needed, and returns a deterministic
 * `CommandResult`. No LLM improvisation: the same command path runs on web,
 * Discord, and Telegram.
 */

import type {
	Action,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	UUID,
} from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/core";
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
	parseAccountsArgs,
	runAccountsRefreshViaRoute,
	runAccountsReportViaRoute,
	runAccountsStrategyViaRoute,
	runAccountsToggleViaRoute,
} from "./accounts";
import { parseBackendArgs, runBackendShowViaRoute } from "./backend";
import {
	type CommandSettings,
	clearCommandSettings,
	getCommandSettings,
	setCommandSetting,
} from "./command-settings";
import {
	parseModelConfigArgs,
	runModelConfigShowViaRoute,
	runModelConfigWriteViaRoute,
} from "./model-config";

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
	"accounts",
	"backend",
];

const DETERMINISTIC_KEYS: ReadonlySet<string> = new Set(
	DETERMINISTIC_COMMAND_KEYS,
);

/** Whether a command's whole effect is handled by this deterministic layer. */
export function isDeterministicCommand(key: string): boolean {
	return DETERMINISTIC_KEYS.has(key);
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
	if (result?.text && result.text.trim().length > 0) return reply(result.text);
	return reply("Conversation compaction completed.");
}

/**
 * `/model local|cloud [id]` drives the SAME loopback runtime-switch route the
 * MODEL_SWITCH action uses (packages/agent/src/api/runtime-switch-routes.ts),
 * so a slash command and an agent action share one switch implementation. A
 * bare model name (no local/cloud target) is not a runtime switch — it falls
 * through to the per-room `/model` preference below.
 */
async function runModelSwitchViaRoute(
	target: "local" | "cloud",
	model: string | undefined,
): Promise<CommandResult> {
	const port = resolveServerOnlyPort(process.env);
	let response: Response;
	try {
		response = await fetch(
			`http://127.0.0.1:${port}/api/runtime/model-switch`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target, ...(model ? { model } : {}) }),
				signal: AbortSignal.timeout(150_000),
			},
		);
	} catch (err) {
		return reply(
			`Couldn't switch the model: ${err instanceof Error ? err.message : String(err)}.`,
		);
	}
	// error-policy:J3 non-JSON/empty response body -> null; the caller reads
	// response.ok / fields defensively, so an unparseable body is a handled shape.
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!response.ok || body?.ok !== true) {
		return reply(
			`Couldn't switch the model: ${
				typeof body?.error === "string"
					? body.error
					: `route returned ${response.status}`
			}.`,
		);
	}
	if (body.target === "cloud") {
		return reply(`Switched to Eliza Cloud inference (${body.model}).`);
	}
	const name =
		typeof body.displayName === "string"
			? body.displayName
			: String(body.model);
	if (body.status === "downloading") {
		const size =
			typeof body.downloadSizeGb === "number"
				? ` (${body.downloadSizeGb} GB)`
				: "";
		return reply(`Switching to on-device ${name} — downloading${size}…`);
	}
	if (body.status === "loading") {
		return reply(`Switching to on-device ${name} — loading now.`);
	}
	return reply(`Switched to on-device ${name}.`);
}

/**
 * Parse a `/model` argument list into a runtime-switch target. Returns null
 * when the first token is neither `local` nor `cloud` (a bare model name), so
 * the caller keeps the per-room preference behavior.
 */
export function parseModelSwitchArgs(
	parsed: ParsedCommand,
): { target: "local" | "cloud"; model?: string } | null {
	const tokens = (parsed.rawArgs?.trim() || parsed.args.join(" ").trim())
		.split(/\s+/)
		.filter(Boolean);
	const first = tokens[0]?.toLowerCase();
	if (first !== "local" && first !== "cloud") return null;
	const model = tokens[1]?.trim();
	return { target: first, ...(model ? { model } : {}) };
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
				? (settings.model ?? resolveModelLabel(runtime))
				: (settings[option.key] ?? "default");
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

		case "model": {
			// `/model show|small|large|coding …` drives the validated global
			// model-config route. The definition now carries requiresAuth (the
			// whole command is operator-facing — connector pickers gate it), and
			// the write subcommands are additionally owner-only here because they
			// mutate config.env for every room (and restart the agent for chat
			// targets).
			const configCommand = parseModelConfigArgs(parsed);
			if (configCommand) {
				if (configCommand.kind === "show") {
					if (!context.isAuthorized) return authError();
					return runModelConfigShowViaRoute();
				}
				if (!context.isElevated) {
					return reply("This command requires elevated permissions.");
				}
				if (configCommand.kind === "usage") {
					return reply(configCommand.error);
				}
				return runModelConfigWriteViaRoute(configCommand.body);
			}
			// `/model local|cloud [id]` is a runtime inference switch shared with
			// the MODEL_SWITCH action; a bare model name stays a per-room setting.
			// The switch mutates the global inference backend — same blast radius
			// as the config writes above, so it carries the same owner-only gate.
			const switchArgs = parseModelSwitchArgs(parsed);
			if (switchArgs) {
				if (!context.isElevated) {
					return reply("This command requires elevated permissions.");
				}
				return runModelSwitchViaRoute(switchArgs.target, switchArgs.model);
			}
			return setOptionCommand(runtime, roomId, parsed, OPTION_COMMANDS.model);
		}

		case "accounts": {
			// Bare `/accounts` is a read the definition-level requiresAuth gate
			// already covers; every subcommand mutates the global account pool, so
			// it carries the same owner-only gate as the /model config writes —
			// including usage errors, so an unprivileged sender can't probe the
			// grammar.
			const accountsCommand = parseAccountsArgs(parsed);
			if (accountsCommand.kind === "report") {
				return runAccountsReportViaRoute();
			}
			if (!context.isElevated) {
				return reply("This command requires elevated permissions.");
			}
			if (accountsCommand.kind === "usage") {
				return reply(accountsCommand.error);
			}
			if (accountsCommand.kind === "strategy") {
				return runAccountsStrategyViaRoute(
					accountsCommand.provider,
					accountsCommand.strategy,
				);
			}
			if (accountsCommand.kind === "refresh") {
				return runAccountsRefreshViaRoute(
					accountsCommand.provider,
					accountsCommand.account,
				);
			}
			return runAccountsToggleViaRoute(
				accountsCommand.kind,
				accountsCommand.provider,
				accountsCommand.account,
			);
		}

		case "backend": {
			const backendCommand = parseBackendArgs(parsed);
			if (backendCommand.kind === "show") {
				return runBackendShowViaRoute();
			}
			if (!context.isElevated) {
				return reply("This command requires elevated permissions.");
			}
			if (backendCommand.kind === "usage") {
				return reply(backendCommand.error);
			}
			// Persist through the config route (config.env + config.env.vars +
			// process.env) — runtime.setSetting is in-memory only and would
			// silently revert on restart.
			return runModelConfigWriteViaRoute({
				target: "coding",
				defaultBackend: backendCommand.backend,
			});
		}

		case "think":
		case "verbose":
		case "reasoning":
		case "queue":
		case "elevated":
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
			return { handled: false, shouldContinue: true };
	}
}

function describeSettings(settings: CommandSettings): string {
	const entries = Object.entries(settings).filter(([, v]) => v);
	if (entries.length === 0) return "none";
	return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}
