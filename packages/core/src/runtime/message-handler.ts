import type {
	MessageHandlerAction,
	MessageHandlerExtract,
	MessageHandlerExtractedRelationship,
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
	const requiresTool =
		typeof plan.requiresTool === "boolean" ? plan.requiresTool : undefined;
	const simple =
		typeof plan.simple === "boolean"
			? plan.simple
			: typeof (parsed as { simple?: unknown }).simple === "boolean"
				? ((parsed as { simple?: boolean }).simple as boolean)
				: undefined;
	const contextSlices = normalizeStringHints(plan.contextSlices, 12);
	const candidateActions = normalizeStringHints(plan.candidateActions, 12);
	const parentActionHints = normalizeStringHints(plan.parentActionHints, 6);

	// Backward-compatibility shim: legacy `plan.simple === true` (or root-level
	// `simple: true`) with empty contexts is treated as `["simple"]`. New
	// callers should emit `contexts: ["simple"]` directly.
	const contexts =
		rawContexts.length === 0 && simple === true
			? [SIMPLE_CONTEXT_ID]
			: rawContexts;

	const extract = parseExtract(parsed.extract);

	const normalizedPlan: V5MessageHandlerOutput["plan"] = {
		contexts,
		reply,
	};
	if (requiresTool !== undefined) {
		normalizedPlan.requiresTool = requiresTool;
	}
	if (simple !== undefined) {
		normalizedPlan.simple = simple;
	}
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
	if (facts.length === 0 && relationships.length === 0) {
		return undefined;
	}
	const result: MessageHandlerExtract = {};
	if (facts.length > 0) result.facts = facts;
	if (relationships.length > 0) result.relationships = relationships;
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

	const legacyContexts = (output as { contexts?: AgentContext[] }).contexts;
	const allContexts = [...(output.plan?.contexts ?? legacyContexts ?? [])];
	const requiresTool = output.plan?.requiresTool === true;
	const explicitlyNonSimple =
		output.plan?.simple === false ||
		(output as { simple?: unknown }).simple === false;

	// `simple` is the shortcut marker. If it is the only context (or contexts
	// is empty), Stage 1 owns the reply and we never enter the planner, unless
	// the route explicitly says this turn needs a tool.
	const nonSimpleContexts = allContexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);

	if ((requiresTool || explicitlyNonSimple) && nonSimpleContexts.length === 0) {
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
