/**
 * COMMAND router action.
 *
 * Single entry point for slash-command operations: help, status, stop, models,
 * list. Replaces the prior 5 individual actions (HELP_COMMAND, STATUS_COMMAND,
 * STOP_COMMAND, MODELS_COMMAND, COMMANDS_LIST).
 *
 * Operation is selected from `parameters.op` first, then inferred from the
 * detected slash command in the message text. All sub-routes are render-only
 * (no LLM calls) — the router is a thin dispatcher over existing logic.
 */

import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { EventType, logger, ModelType } from "@elizaos/core";
import { detectCommand } from "../parser";
import { getEnabledCommands } from "../registry";

type CommandOp = "help" | "status" | "stop" | "models" | "list";

const ALL_OPS: readonly CommandOp[] = [
	"help",
	"status",
	"stop",
	"models",
	"list",
] as const;

/**
 * Map a parsed command key to a router op.
 *
 * The registry keys overlap closely with router ops, but stop/abort/cancel
 * collapse to "stop" and the legacy "commands" key collapses to "list".
 */
function commandKeyToOp(key: string): CommandOp | null {
	if (key === "help") return "help";
	if (key === "status") return "status";
	if (key === "stop" || key === "abort" || key === "cancel") return "stop";
	if (key === "models") return "models";
	if (key === "commands") return "list";
	return null;
}

function readOp(
	message: Memory,
	options?: HandlerOptions | Record<string, unknown>,
): CommandOp | null {
	const direct = (options ?? {}) as Record<string, unknown>;
	const params =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	const requested = params.op ?? direct.op;
	if (typeof requested === "string") {
		const normalized = requested.trim().toLowerCase();
		if ((ALL_OPS as readonly string[]).includes(normalized)) {
			return normalized as CommandOp;
		}
	}

	const detection = detectCommand(message.content?.text ?? "");
	if (detection.isCommand && detection.command) {
		return commandKeyToOp(detection.command.key);
	}
	return null;
}

interface DirectiveModelState {
	provider?: string;
	model?: string;
}

interface DirectiveSessionState {
	thinking: string | boolean;
	verbose: boolean | string;
	reasoning: boolean | string;
	elevated: boolean | string;
	model?: DirectiveModelState;
}

interface DirectiveParserService {
	getSessionState?: (roomId: string) => DirectiveSessionState | undefined;
}

function formatHelp(): string {
	const commands = getEnabledCommands();
	const lines: string[] = ["**Available Commands:**\n"];

	const categories = [
		{ key: "status", name: "Status" },
		{ key: "session", name: "Session" },
		{ key: "options", name: "Options" },
		{ key: "management", name: "Management" },
		{ key: "media", name: "Media" },
		{ key: "tools", name: "Tools" },
	];

	for (const cat of categories) {
		const catCommands = commands.filter((c) => c.category === cat.key);
		if (catCommands.length === 0) continue;
		lines.push(`\n**${cat.name}:**`);
		for (const cmd of catCommands) {
			const aliases = cmd.textAliases.slice(0, 2).join(", ");
			lines.push(`• ${aliases} - ${cmd.description}`);
		}
	}

	const uncategorized = commands.filter((c) => !c.category);
	if (uncategorized.length > 0) {
		lines.push("\n**Other:**");
		for (const cmd of uncategorized) {
			const aliases = cmd.textAliases.slice(0, 2).join(", ");
			lines.push(`• ${aliases} - ${cmd.description}`);
		}
	}

	return lines.join("\n");
}

async function buildStatusReport(
	runtime: IAgentRuntime,
	roomId: string,
): Promise<string> {
	const lines: string[] = ["**Session Status:**\n"];

	lines.push(`**Agent:** ${runtime.character.name ?? runtime.agentId}`);
	lines.push(`**Room:** ${roomId}`);

	try {
		const directiveService = runtime.getService(
			"directive-parser",
		) as DirectiveParserService | null;
		if (directiveService) {
			const state = directiveService.getSessionState?.(roomId);
			if (state) {
				lines.push(`\n**Directives:**`);
				lines.push(`• Thinking: ${state.thinking}`);
				lines.push(`• Verbose: ${state.verbose}`);
				lines.push(`• Reasoning: ${state.reasoning}`);
				lines.push(`• Elevated: ${state.elevated}`);
				if (state.model?.provider || state.model?.model) {
					const modelStr = state.model.provider
						? `${state.model.provider}/${state.model.model}`
						: state.model.model;
					lines.push(`• Model: ${modelStr}`);
				}
			}
		}
	} catch {
		// Directive plugin not available.
	}

	try {
		const tasks = await runtime.getTasks({
			roomId,
			agentIds: [runtime.agentId],
		});
		if (tasks.length > 0) {
			lines.push(`\n**Tasks:** ${tasks.length} pending`);
		}
	} catch {
		// Task retrieval may not be available.
	}

	return lines.join("\n");
}

function describeModelType(modelType: string): string {
	const descriptions: Record<string, string> = {
		[ModelType.TEXT_SMALL]: "Text (Small)",
		[ModelType.TEXT_LARGE]: "Text (Large)",
		[ModelType.TEXT_COMPLETION]: "Text Completion",
		[ModelType.TEXT_EMBEDDING]: "Embedding",
		[ModelType.IMAGE]: "Image Generation",
		[ModelType.IMAGE_DESCRIPTION]: "Image Description",
		[ModelType.TRANSCRIPTION]: "Transcription",
		[ModelType.TEXT_TO_SPEECH]: "Text-to-Speech",
		[ModelType.AUDIO]: "Audio",
		[ModelType.VIDEO]: "Video",
		[ModelType.OBJECT_SMALL]: "Object (Small)",
		[ModelType.OBJECT_LARGE]: "Object (Large)",
		[ModelType.RESEARCH]: "Research",
	};
	return descriptions[modelType] ?? modelType;
}

function formatModels(runtime: IAgentRuntime): string {
	const lines: string[] = ["**Available Models:**\n"];
	const seen = new Set<string>();
	const registeredTypes: string[] = [];

	for (const modelType of Object.values(ModelType)) {
		if (seen.has(modelType)) continue;
		seen.add(modelType);
		try {
			const handler = runtime.getModel(modelType);
			if (handler) {
				registeredTypes.push(modelType);
			}
		} catch {
			// Model type not registered.
		}
	}

	if (registeredTypes.length > 0) {
		lines.push("**Registered Model Types:**");
		for (const modelType of registeredTypes) {
			lines.push(`• ${describeModelType(modelType)} (\`${modelType}\`)`);
		}
	} else {
		lines.push("No model handlers are currently registered.");
	}

	const modelProvider = runtime.getSetting("MODEL_PROVIDER");
	const modelName = runtime.getSetting("MODEL_NAME");
	if (modelProvider || modelName) {
		lines.push("\n**Current Configuration:**");
		if (modelProvider) lines.push(`• Provider: ${modelProvider}`);
		if (modelName) lines.push(`• Model: ${modelName}`);
	}

	lines.push("\n\n_Use /model <provider/model> to switch models._");
	return lines.join("\n");
}

function formatList(): string {
	const commands = getEnabledCommands();
	const lines: string[] = [`**Commands (${commands.length}):**\n`];
	for (const cmd of commands) {
		const aliases = cmd.textAliases.join(", ");
		const authNote = cmd.requiresAuth ? " [auth]" : "";
		const elevatedNote = cmd.requiresElevated ? " [elevated]" : "";
		lines.push(`• **${cmd.key}**: ${aliases}${authNote}${elevatedNote}`);
	}
	return lines.join("\n");
}

async function handleStop(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<string> {
	try {
		await runtime.emitEvent(EventType.HOOK_COMMAND_STOP, {
			runtime,
			sessionKey: message.roomId,
			messages: [],
			timestamp: new Date(),
			context: {
				entityId: message.entityId,
				source: message.content?.source,
			},
			command: "stop" as const,
			senderId: message.entityId,
			commandSource: message.content?.source,
		});
	} catch (err) {
		logger.warn(
			{ src: "plugin-commands", err },
			"Failed to emit HOOK_COMMAND_STOP event",
		);
	}
	return "✓ Stop requested. Current operations will be cancelled.";
}

export const commandAction: Action = {
	name: "COMMAND",
	contexts: ["general", "settings", "agent_internal"],
	contextGate: { anyOf: ["general", "settings", "agent_internal"] },
	roleGate: { minRole: "USER" },
	similes: [
		"COMMAND",
		"SLASH_COMMAND",
		"HELP_COMMAND",
		"STATUS_COMMAND",
		"STOP_COMMAND",
		"MODELS_COMMAND",
		"COMMANDS_LIST",
	],
	description:
		"Slash-command router. Operations: help, status, stop, models, list. Selects the operation from parameters.op or the detected /<command> in the message text.",
	descriptionCompressed: "Slash commands: help, status, stop, models, list.",
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		const detection = detectCommand(message.content?.text ?? "");
		if (!detection.isCommand || !detection.command) return false;
		return commandKeyToOp(detection.command.key) !== null;
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: HandlerOptions | undefined,
		callback: HandlerCallback | undefined,
	): Promise<ActionResult> => {
		const op = readOp(message, options);
		if (op === null) {
			const text =
				"COMMAND requires op: help, status, stop, models, or list (or a matching slash command in the message).";
			await callback?.({ text });
			return { success: false, text };
		}

		switch (op) {
			case "help": {
				const text = formatHelp();
				await callback?.({ text });
				return {
					success: true,
					text,
					data: { op, commandCount: getEnabledCommands().length },
				};
			}
			case "status": {
				const text = await buildStatusReport(runtime, message.roomId);
				await callback?.({ text });
				return { success: true, text, data: { op } };
			}
			case "stop": {
				const text = await handleStop(runtime, message);
				await callback?.({ text });
				return { success: true, text, data: { op } };
			}
			case "models": {
				const text = formatModels(runtime);
				await callback?.({ text });
				return { success: true, text, data: { op } };
			}
			case "list": {
				const text = formatList();
				await callback?.({ text });
				return {
					success: true,
					text,
					data: { op, commandCount: getEnabledCommands().length },
				};
			}
		}
	},
	parameters: [
		{
			name: "op",
			description:
				"Command operation. One of: help, status, stop, models, list.",
			required: false,
			schema: { type: "string", enum: [...ALL_OPS] },
		},
	],
	examples: [
		[
			{ name: "user", content: { text: "/help" } },
			{
				name: "assistant",
				content: {
					text: "**Available Commands:**\n\n**Status:**\n• /help - Show available commands...",
					actions: ["COMMAND"],
				},
			},
		],
		[
			{ name: "user", content: { text: "/status" } },
			{
				name: "assistant",
				content: {
					text: "**Session Status:**\n\n**Agent:** Eliza...",
					actions: ["COMMAND"],
				},
			},
		],
		[
			{ name: "user", content: { text: "/stop" } },
			{
				name: "assistant",
				content: {
					text: "✓ Stop requested. Current operations will be cancelled.",
					actions: ["COMMAND"],
				},
			},
		],
		[
			{ name: "user", content: { text: "/models" } },
			{
				name: "assistant",
				content: {
					text: "**Available Models:**\n\n**Registered Model Types:**\n• Text (Large)...",
					actions: ["COMMAND"],
				},
			},
		],
		[
			{ name: "user", content: { text: "/commands" } },
			{
				name: "assistant",
				content: {
					text: "**Commands (15):**\n\n• **help**: /help, /h, /?...",
					actions: ["COMMAND"],
				},
			},
		],
	] as ActionExample[][],
};
