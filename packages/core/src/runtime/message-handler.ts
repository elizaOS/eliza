import type {
	MessageHandlerAction,
	MessageHandlerExtract,
	MessageHandlerExtractedRelationship,
	MessageHandlerResult,
} from "../types/components";
import type { AgentContext } from "../types/contexts";
import { normalizeTopics } from "./builtin-field-evaluators";
import { parseJsonObject, stripJsonStructuralJunkReply } from "./json-output";
import {
	looksLikeRawFieldTranscript,
	parseFieldTranscript,
	splitTranscriptList,
} from "./response-field-transcript";

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
 * Expects the canonical response-handler field-registry envelope:
 * `{ shouldRespond, contexts, intents, replyText, candidateActionNames, facts,
 * relationships, addressedTo, emotion }`. The internal result still carries
 * the `plan` sub-object because the downstream runtime contract has not been
 * renamed.
 */
export function parseMessageHandlerOutput(
	raw: string,
): V5MessageHandlerOutput | null {
	const parsed = parseJsonObject<Record<string, unknown>>(raw);
	if (!parsed) {
		// Some providers (cli-inference / claude-sdk warm sessions in text mode)
		// echo the field set back as a plain-text keyed transcript instead of
		// JSON: `shouldRespond: RESPOND\n\nreplyText: ...`. Recover the fields
		// with the transcript grammar (multi-line values with embedded blank
		// lines terminate only at the next `^<knownField>:` line). Without this
		// the whole raw transcript falls through the tolerant plain-text path and
		// is shipped verbatim to the user channel (#11712).
		return parseMessageHandlerFieldTranscript(raw);
	}

	const processMessage = normalizeMessageHandlerAction(parsed.shouldRespond);
	const contexts = Array.isArray(parsed.contexts)
		? parsed.contexts.map((context) => String(context).trim()).filter(Boolean)
		: [];
	const replyRaw =
		typeof parsed.replyText === "string"
			? stripJsonStructuralJunkReply(parsed.replyText)
			: undefined;
	const candidateActions = normalizeStringHints(
		parsed.candidateActionNames,
		12,
	);

	const extract = parseExtract(parsed);

	const normalizedPlan: V5MessageHandlerOutput["plan"] = {
		contexts,
		reply: replyRaw,
	};
	if (candidateActions.length > 0) {
		normalizedPlan.candidateActions = candidateActions;
	}

	return {
		processMessage,
		plan: normalizedPlan,
		thought: "",
		...(extract ? { extract } : {}),
	};
}

/**
 * Parse the plain-text keyed field transcript into a MessageHandlerResult.
 * Mirrors the JSON path in {@link parseMessageHandlerOutput} but sources the
 * fields from {@link parseFieldTranscript}. Returns null when the text is not a
 * recognizable transcript (no known field lines) so the caller can fall through
 * to the tolerant plain-text handler.
 */
function parseMessageHandlerFieldTranscript(
	raw: string,
): V5MessageHandlerOutput | null {
	// Only claim text whose own skeleton IS the envelope: it must lead with a
	// known field line (outside any code fence) and carry a hallmark field
	// (`shouldRespond:` / `replyText:`) at the top level. Prose that merely
	// QUOTES field lines — e.g. the model diagnosing a leaked transcript the
	// user pasted — must fall through to the tolerant plain-text handler
	// INTACT; claiming it here would drop every line before the quoted
	// `replyText:` and ship only the quote's tail as the answer.
	if (!looksLikeRawFieldTranscript(raw)) return null;
	const transcript = parseFieldTranscript(raw);
	if (!transcript) return null;
	const { fields } = transcript;

	// Require at least one hallmark field before treating the text as a
	// structured transcript: the routing field (`shouldRespond:` may
	// legitimately stand alone, e.g. an IGNORE echo with no reply) or the
	// reply-bearing field (`replyText:`). A lone stray `topics:` line in
	// otherwise-prose output should NOT be reinterpreted as an envelope.
	const hasShouldRespond = typeof fields.shouldRespond === "string";
	const hasReplyText = typeof fields.replyText === "string";
	if (!hasShouldRespond && !hasReplyText) return null;

	const processMessage = normalizeMessageHandlerAction(fields.shouldRespond);
	const contexts = splitTranscriptList(fields.contexts);
	const replyRaw =
		typeof fields.replyText === "string"
			? stripJsonStructuralJunkReply(fields.replyText)
			: undefined;
	const candidateActions = normalizeStringHints(
		splitTranscriptList(fields.candidateActionNames),
		12,
	);

	const extract = parseExtract({
		facts: splitTranscriptList(fields.facts),
		addressedTo: splitTranscriptList(fields.addressedTo),
		topics: splitTranscriptList(fields.topics),
	});

	const normalizedPlan: V5MessageHandlerOutput["plan"] = {
		contexts,
		reply: replyRaw,
	};
	if (candidateActions.length > 0) {
		normalizedPlan.candidateActions = candidateActions;
	}

	return {
		processMessage,
		plan: normalizedPlan,
		thought: "",
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
	const topics = normalizeTopics(source.topics);
	if (
		facts.length === 0 &&
		relationships.length === 0 &&
		addressedTo.length === 0 &&
		topics.length === 0
	) {
		return undefined;
	}
	const result: MessageHandlerExtract = {};
	if (facts.length > 0) result.facts = facts;
	if (relationships.length > 0) result.relationships = relationships;
	if (addressedTo.length > 0) result.addressedTo = addressedTo;
	if (topics.length > 0) result.topics = topics;
	return result;
}

export function routeMessageHandlerOutput(
	output: V5MessageHandlerOutput,
	options?: { suppressToolPromotion?: boolean },
): MessageHandlerRoute {
	const processMessage = output.processMessage;
	if (processMessage === "IGNORE") {
		return { type: "ignored", output };
	}
	if (processMessage === "STOP") {
		return { type: "stopped", output };
	}

	const allContexts = [...output.plan.contexts];
	const requiresTool = output.plan.requiresTool === true;
	const candidateActions = output.plan.candidateActions ?? [];
	const hasCandidateActions = candidateActions.length > 0;

	// `simple` is the shortcut marker. If it is the only context (or contexts
	// is empty), Stage 1 owns the reply and we never enter the planner — unless
	// the route explicitly says this turn needs a tool, in which case we fall
	// through to planning against `general`.
	const nonSimpleContexts = allContexts.filter(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);

	// Resolve the self-contradiction shape `simple=true + requiresTool=false +
	// candidateActions=[BASH/SHELL/TASKS/...]` by promoting to planning. The
	// model is signaling both "no tool needed" (simple-path) AND "this tool
	// would fulfill the request" (candidateActions hint) — those cannot both
	// be true. The candidateActions hint is the more reliable signal because
	// it names a specific exposed tool; honor it and run the planner.
	//
	// Live regression on 2026-05-25 (trajectories tj-c227b5bbff288a,
	// tj-d5e298b2542aa0): probes "find files in /etc that contain the word
	// hostname" and "what files are in /tmp right now" produced
	// `{simple=true, requiresTool=false, candidateActions=["BASH"],
	// replyText:"On it."}` — the user saw the bare-ack and nothing else
	// because the planner was never invoked. The Stage-1 prompt rule that
	// bans bare-ack on simple-path is a soft contract the model occasionally
	// violates; this structural promotion catches the violation at the
	// routing layer.
	const candidateActionsRequestPlanning =
		hasCandidateActions && output.plan.requiresTool !== false;
	// #9874 item 1: when the caller has identified this turn as explicitly
	// addressed to another participant (not us), do NOT promote a simple-path turn
	// into forced tool planning. The agent is overhearing talk it was not asked to
	// act on; forcing a tool fabricates a phantom task (the false-ack seed). The
	// flag is a uniform addressing signal — it does not depend on whether the other
	// participant is a bot. The Stage-1 simple reply still ships via the
	// final_reply branch below.
	const promotionRequested =
		(requiresTool || candidateActionsRequestPlanning) &&
		nonSimpleContexts.length === 0;
	if (promotionRequested && !options?.suppressToolPromotion) {
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
	return String(output.plan.reply ?? "").trim();
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
