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

export function parseMessageHandlerOutput(
	raw: string,
): V5MessageHandlerOutput | null {
	const parsed = parseJsonObject<Record<string, unknown>>(raw);
	if (!parsed) {
		return null;
	}

	const action = normalizeMessageHandlerAction(parsed.action);
	const contexts = Array.isArray(parsed.contexts)
		? parsed.contexts.map((context) => String(context).trim()).filter(Boolean)
		: [];

	return {
		action,
		simple: parsed.simple === true,
		contexts,
		thought: typeof parsed.thought === "string" ? parsed.thought : "",
		reply: typeof parsed.reply === "string" ? parsed.reply : undefined,
	};
}

export function routeMessageHandlerOutput(
	output: V5MessageHandlerOutput,
): MessageHandlerRoute {
	if (output.action === "IGNORE") {
		return { type: "ignored", output };
	}
	if (output.action === "STOP") {
		return { type: "stopped", output };
	}

	const contexts = [...output.contexts];
	if (contexts.length > 0) {
		return {
			type: "planning_needed",
			output,
			contexts,
		};
	}

	const reply = getMessageHandlerReply(output);
	if (output.simple && reply.length > 0) {
		return {
			type: "final_reply",
			reply,
			output,
		};
	}

	return {
		type: "planning_needed",
		output,
		contexts,
	};
}

export function getMessageHandlerReply(output: V5MessageHandlerOutput): string {
	return String(output.reply ?? "").trim();
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
