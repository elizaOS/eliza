import type {
	MessageHandlerAction,
	MessageHandlerExtract,
	MessageHandlerExtractedRelationship,
	MessageHandlerResult,
} from "../types/components";
import type { AgentContext } from "../types/contexts";
import { parseJsonObject } from "./json-output";
import { looksLikeRefusal } from "./refusal-detector";

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
 * tools or context providers. When `contexts` is exactly `[SIMPLE_CONTEXT_ID]`
 * (or empty) the runtime takes the shortcut and emits `replyText` without
 * invoking the planner.
 */
export const SIMPLE_CONTEXT_ID = "simple";

/**
 * Parse a HANDLE_RESPONSE payload into the internal {@link MessageHandlerResult}.
 *
 * Expects the canonical flat envelope `{ shouldRespond, thought?, replyText,
 * contexts, contextSlices?, candidateActions?, parentActionHints?,
 * requiresTool?, extract? }` (what Eliza-1 / the current `HANDLE_RESPONSE_SCHEMA`
 * emit). The internal result still carries the `plan` sub-object so the rest of
 * the message pipeline is unchanged.
 */
export function parseMessageHandlerOutput(
	raw: string,
): V5MessageHandlerOutput | null {
	const parsed = parseJsonObject<Record<string, unknown>>(raw);
	if (!parsed) {
		return null;
	}

	const processMessage = normalizeMessageHandlerAction(parsed.shouldRespond);
	const contexts = Array.isArray(parsed.contexts)
		? parsed.contexts.map((context) => String(context).trim()).filter(Boolean)
		: [];
	const replyRaw =
		typeof parsed.replyText === "string" ? parsed.replyText : undefined;
	const requiresTool =
		typeof parsed.requiresTool === "boolean" ? parsed.requiresTool : undefined;
	const contextSlices = normalizeStringHints(parsed.contextSlices, 12);
	const candidateActions = normalizeStringHints(parsed.candidateActions, 12);
	const parentActionHints = normalizeStringHints(parsed.parentActionHints, 6);

	const extract = parseExtract(parsed.extract);

	// Refusal suppression for the planning path (elizaOS/eliza#7620).
	// When the model routes to a non-simple context OR populates candidate
	// actions, the planner stage will produce the user-facing message and the
	// Stage-1 `replyText` is intended to be a brief acknowledgement. Some
	// safety-tuned hosted models (Cerebras-served `gpt-oss-120b`,
	// `qwen-3-235b-a22b-instruct-2507`) still emit a refusal here even with
	// anti-refusal language in the system prompt. We blank the reply when it
	// looks like a refusal AND a planning path is selected — the user sees
	// the planner's message instead. Refusals on the simple path pass through
	// unchanged (the model may legitimately decline e.g. unsafe requests).
	const nonSimpleContexts = contexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);
	const planningPath =
		nonSimpleContexts.length > 0 || candidateActions.length > 0;
	const reply = planningPath && looksLikeRefusal(replyRaw) ? "" : replyRaw;

	const normalizedPlan: V5MessageHandlerOutput["plan"] = {
		contexts,
		reply,
		...(requiresTool !== undefined ? { requiresTool } : {}),
	};
	if (contextSlices.length > 0) {
		normalizedPlan.contextSlices = contextSlices;
	}
	if (candidateActions.length > 0) {
		normalizedPlan.candidateActions = candidateActions;
	}
	if (parentActionHints.length > 0) {
		normalizedPlan.parentActionHints = parentActionHints;
	}

	return {
		processMessage,
		plan: normalizedPlan,
		thought: typeof parsed.thought === "string" ? parsed.thought : "",
		...(extract ? { extract } : {}),
	};
}

function normalizeStringHints(raw: unknown, maxItems: number): string[] {
	if (!Array.isArray(raw) || maxItems <= 0) {
		return [];
	}
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") {
			continue;
		}
		const value = item.trim();
		if (!value) {
			continue;
		}
		const dedupeKey = value.toLowerCase();
		if (seen.has(dedupeKey)) {
			continue;
		}
		seen.add(dedupeKey);
		result.push(value);
		if (result.length >= maxItems) {
			break;
		}
	}
	return result;
}

function parseExtract(raw: unknown): MessageHandlerExtract | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const facts = Array.isArray(source.facts)
		? source.facts
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry): entry is string => entry.length > 0)
		: [];
	const relationships = Array.isArray(source.relationships)
		? source.relationships
				.map((entry): MessageHandlerExtractedRelationship | null => {
					if (!entry || typeof entry !== "object") return null;
					const rel = entry as Record<string, unknown>;
					const subject =
						typeof rel.subject === "string" ? rel.subject.trim() : "";
					const predicate =
						typeof rel.predicate === "string" ? rel.predicate.trim() : "";
					const object =
						typeof rel.object === "string" ? rel.object.trim() : "";
					if (!subject || !predicate || !object) return null;
					return { subject, predicate, object };
				})
				.filter(
					(entry): entry is MessageHandlerExtractedRelationship =>
						entry !== null,
				)
		: [];
	const addressedTo = Array.isArray(source.addressedTo)
		? source.addressedTo
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry): entry is string => entry.length > 0)
		: [];
	if (
		facts.length === 0 &&
		relationships.length === 0 &&
		addressedTo.length === 0
	) {
		return undefined;
	}
	const result: MessageHandlerExtract = {};
	if (facts.length > 0) result.facts = facts;
	if (relationships.length > 0) result.relationships = relationships;
	if (addressedTo.length > 0) result.addressedTo = addressedTo;
	return result;
}

export function routeMessageHandlerOutput(
	output: V5MessageHandlerOutput,
): MessageHandlerRoute {
	const processMessage = output.processMessage;
	if (processMessage === "IGNORE") {
		return { type: "ignored", output };
	}
	if (processMessage === "STOP") {
		return { type: "stopped", output };
	}

	const allContexts = [...(output.plan?.contexts ?? [])];
	const requiresTool = output.plan?.requiresTool === true;

	// `simple` is the shortcut marker. If it is the only context (or contexts
	// is empty), Stage 1 owns the reply and we never enter the planner — unless
	// the route explicitly says this turn needs a tool, in which case we fall
	// through to planning against `general`.
	const nonSimpleContexts = allContexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);

	if (requiresTool && nonSimpleContexts.length === 0) {
		return {
			type: "planning_needed",
			output,
			contexts: ["general"],
		};
	}

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
	return String(output.plan?.reply ?? "").trim();
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
