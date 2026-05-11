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
 * tools or context providers. When `contexts` is exactly `[SIMPLE_CONTEXT_ID]`
 * (or empty) the runtime takes the shortcut and emits `replyText` without
 * invoking the planner.
 */
export const SIMPLE_CONTEXT_ID = "simple";

/**
 * Parse a HANDLE_RESPONSE payload into the internal {@link MessageHandlerResult}.
 *
 * Accepts two on-the-wire shapes:
 *  - the canonical flat envelope `{ shouldRespond, thought?, replyText, contexts,
 *    contextSlices?, candidateActions?, parentActionHints?, requiresTool?, extract? }`
 *    (what Eliza-1 / the current `HANDLE_RESPONSE_SCHEMA` emit), and
 *  - the legacy nested form `{ processMessage, thought, plan:{ contexts, reply,
 *    requiresTool?, simple?, ... }, extract? }` (older trajectories, older tool
 *    callers).
 *
 * Mapping: `shouldRespond`↔`processMessage`, `replyText`↔`plan.reply`,
 * `contexts`↔`plan.contexts`. `plan.simple === true` (or root `simple === true`)
 * with no contexts folds into `contexts: ["simple"]`. The internal result still
 * carries the `plan` sub-object so the rest of the message pipeline is unchanged.
 */
export function parseMessageHandlerOutput(
	raw: string,
): V5MessageHandlerOutput | null {
	const parsed = parseJsonObject<Record<string, unknown>>(raw);
	if (!parsed) {
		return null;
	}

	// Flat envelope keeps its hint/control fields at the top level; legacy
	// callers nest them under `plan`. Read from `plan` when present, else root.
	const legacyPlan =
		parsed.plan && typeof parsed.plan === "object" && !Array.isArray(parsed.plan)
			? (parsed.plan as Record<string, unknown>)
			: undefined;
	const fields = legacyPlan ?? parsed;
	const processMessage = normalizeMessageHandlerAction(
		parsed.shouldRespond ?? parsed.processMessage ?? parsed.action,
	);
	const rawContexts = Array.isArray(fields.contexts)
		? fields.contexts.map((context) => String(context).trim()).filter(Boolean)
		: [];
	// Canonical field is `replyText`; legacy nested form used `plan.reply`.
	const replyRaw =
		typeof parsed.replyText === "string"
			? parsed.replyText
			: typeof fields.reply === "string"
				? (fields.reply as string)
				: typeof fields.replyText === "string"
					? (fields.replyText as string)
					: undefined;
	const reply = replyRaw;
	const requiresTool =
		typeof fields.requiresTool === "boolean" ? fields.requiresTool : undefined;
	const simple =
		typeof fields.simple === "boolean"
			? (fields.simple as boolean)
			: typeof (parsed as { simple?: unknown }).simple === "boolean"
				? ((parsed as { simple?: boolean }).simple as boolean)
				: undefined;
	const contextSlices = normalizeStringHints(fields.contextSlices, 12);
	const candidateActions = normalizeStringHints(fields.candidateActions, 12);
	const parentActionHints = normalizeStringHints(fields.parentActionHints, 6);

	// Legacy `simple === true` with empty contexts → `["simple"]`. New callers
	// emit `contexts: ["simple"]` directly.
	const contexts =
		rawContexts.length === 0 && simple === true
			? [SIMPLE_CONTEXT_ID]
			: rawContexts;

	const extract = parseExtract(parsed.extract);

	const normalizedPlan: V5MessageHandlerOutput["plan"] = {
		contexts,
		reply,
		...(requiresTool !== undefined ? { requiresTool } : {}),
		...(simple !== undefined ? { simple } : {}),
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

	const legacyContexts = (output as { contexts?: AgentContext[] }).contexts;
	const allContexts = [...(output.plan?.contexts ?? legacyContexts ?? [])];
	const requiresTool = output.plan?.requiresTool === true;
	const explicitlyNonSimple =
		output.plan?.simple === false ||
		(output as { simple?: unknown }).simple === false;

	// `simple` is the shortcut marker. If it is the only context (or contexts
	// is empty), Stage 1 owns the reply and we never enter the planner — unless
	// the route explicitly says this turn needs a tool, in which case we fall
	// through to planning against `general`.
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
