import type {
	MessageHandlerAction,
	MessageHandlerResult,
} from "../types/components";
import type { AgentContext } from "../types/contexts";
import { parseJsonObject } from "./json-output";

export type V5MessageHandlerOutput = MessageHandlerResult;

export type MessageHandlerRoute =
	| {
			type: "ignored" | "stopped";
			output: V5MessageHandlerOutput;
	  }
	| {
			type: "final_reply";
			reply: string;
			output: V5MessageHandlerOutput;
	  }
	| {
			type: "planning_needed";
			output: V5MessageHandlerOutput;
			contexts: AgentContext[];
	  };

/**
 * Identifier used by the messageHandler to mark a direct reply that needs no
 * tools or context providers. When `plan.contexts` is exactly `[SIMPLE_CONTEXT_ID]`
 * the runtime takes the shortcut and emits `plan.reply` (or generates one)
 * without invoking the planner.
 */
export const SIMPLE_CONTEXT_ID = "simple";

export function parseMessageHandlerOutput(
	raw: string,
): V5MessageHandlerOutput | null {
	const parsed = parseJsonObject<Record<string, unknown>>(raw);
	if (!parsed) {
		return null;
	}

	const plan =
		parsed.plan && typeof parsed.plan === "object"
			? (parsed.plan as Record<string, unknown>)
			: parsed;
	const processMessage = normalizeMessageHandlerAction(
		parsed.processMessage ?? parsed.action,
	);
	const rawContexts = Array.isArray(plan.contexts)
		? plan.contexts.map((context) => String(context).trim()).filter(Boolean)
		: [];
	const reply = typeof plan.reply === "string" ? plan.reply : undefined;

	// Backward-compatibility shim: legacy `plan.simple === true` (or root-level
	// `simple: true`) with empty contexts is treated as `["simple"]`. New
	// callers should emit `contexts: ["simple"]` directly.
	const legacySimpleFlag =
		plan.simple === true || (parsed as { simple?: unknown }).simple === true;
	const contexts =
		rawContexts.length === 0 && legacySimpleFlag
			? [SIMPLE_CONTEXT_ID]
			: rawContexts;

	return {
		processMessage,
		plan: {
			contexts,
			reply,
		},
		action: processMessage,
		contexts,
		thought: typeof parsed.thought === "string" ? parsed.thought : "",
		reply,
	};
}

export function routeMessageHandlerOutput(
	output: V5MessageHandlerOutput,
): MessageHandlerRoute {
	const processMessage = output.processMessage ?? output.action;
	if (processMessage === "IGNORE") {
		return { type: "ignored", output };
	}
	if (processMessage === "STOP") {
		return { type: "stopped", output };
	}

	const allContexts = [...(output.plan?.contexts ?? output.contexts ?? [])];

	// `simple` is the shortcut marker. If it is the only context (or contexts
	// is empty), Stage 1 owns the reply and we never enter the planner.
	const nonSimpleContexts = allContexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);

	if (nonSimpleContexts.length === 0) {
		return {
			type: "final_reply",
			reply: getMessageHandlerReply(output),
			output,
		};
	}

	// Mixed selection: drop the `simple` marker and plan against the rest.
	return {
		type: "planning_needed",
		output,
		contexts: nonSimpleContexts,
	};
}

export function getMessageHandlerReply(output: V5MessageHandlerOutput): string {
	return String(output.plan?.reply ?? output.reply ?? "").trim();
}

function normalizeMessageHandlerAction(value: unknown): MessageHandlerAction {
	const normalized = String(value ?? "")
		.trim()
		.toUpperCase();
	if (
		normalized === "RESPOND" ||
		normalized === "IGNORE" ||
		normalized === "STOP"
	) {
		return normalized;
	}
	return "RESPOND";
}
