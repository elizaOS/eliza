/**
 * Built-in `ResponseHandlerFieldEvaluator`s — the canonical core fields the
 * Stage-1 response handler extracts from every turn.
 *
 * The model-facing schema is a flat list of typed fields. Each field is an
 * independent registered evaluator with:
 *
 *   - description: verbatim in the system prompt
 *   - schema:      JSON schema slice (parameter descriptions also visible
 *                  to the LLM in strict mode)
 *   - parse:       validate / normalize the LLM's value
 *   - handle:      optional pipeline step (most core fields don't have one
 *                  — the parsed value flows through to downstream consumers)
 *
 * Per the contract:
 *   - Flat: no `plan.*` wrapper
 *   - All required: empty array / empty string for N/A
 *   - `simple` is a context name, not a flag (contexts: ["simple"])
 *   - `STOP` remains a first-class terminal response for explicit stop requests
 *   - No `thought` / `requiresTool` / `contextSlices` / `parentActionHints`
 *     (derivable, redundant, or prompt theater)
 *   - New `intents` field for short verb phrases (routing-friendly)
 *
 * Register via `runtime.registerResponseHandlerFieldEvaluator(...)`. The
 * canonical set is exported as `BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS`
 * for runtime init to consume.
 */

import { SHOULD_RESPOND_SCHEMA_DESCRIPTION } from "../actions/to-tool";
import type { ReplyEffectStatus } from "../types/components";
import type { JSONSchema } from "../types/model";
import { trimEndCharacters } from "../utils/string-boundaries";
import { stripJsonStructuralJunkReply } from "./json-output";
import type { ResponseHandlerFieldEvaluator } from "./response-handler-field-evaluator";

/**
 * Stage-1 envelope `emotion` enum value set — kept in lock-step with
 * `EXPRESSIVE_EMOTION_ENUM` exported from
 * `/plugin-local-inference/services/voice/expressive-tags.ts`.
 *
 * It is **redeclared here** instead of imported because `@elizaos/core` may not
 * depend on `@elizaos/plugin-local-inference` (dependency direction is inward
 * per AGENTS.md "10 Clean Architecture Commandments" §1). A vitest in the
 * plugin verifies the two arrays stay byte-equal; if you change one, update
 * the other.
 */
const EXPRESSIVE_EMOTION_ENUM_VALUES = [
	"none",
	"happy",
	"sad",
	"angry",
	"nervous",
	"calm",
	"excited",
	"whisper",
] as const;
type ExpressiveEmotionEnumValue =
	(typeof EXPRESSIVE_EMOTION_ENUM_VALUES)[number];

function isExpressiveEmotionEnumValue(
	value: string,
): value is ExpressiveEmotionEnumValue {
	return (EXPRESSIVE_EMOTION_ENUM_VALUES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// shouldRespond — priority 5 (always first)
// ---------------------------------------------------------------------------

export const shouldRespondFieldEvaluator: ResponseHandlerFieldEvaluator<
	"RESPOND" | "IGNORE" | "STOP"
> = {
	name: "shouldRespond",
	description:
		"RESPOND when the current message addresses you, assigns you work, clearly continues a question you asked, or needs a concrete correction or action specifically from you. A question broadcast to a group is not by itself a reason to interrupt; apply the ambient-turn policy when present. IGNORE acknowledgements, reactions, side chatter, feeds, and messages directed to other people. STOP only explicit stop/terminate/no more work. DM usually RESPOND unless explicit stop.",
	descriptionCompressed:
		"RESPOND when the current message addresses you, assigns work, continues your question, or specifically needs your correction/action; otherwise apply ambient policy and IGNORE reactions, feeds, or others' conversation; STOP only explicit stop.",
	priority: 5,
	schema: {
		type: "string",
		enum: ["RESPOND", "IGNORE", "STOP"],
		description: SHOULD_RESPOND_SCHEMA_DESCRIPTION,
	},
	parse(value) {
		const normalized =
			typeof value === "string" ? value.trim().toUpperCase() : "";
		if (
			normalized === "RESPOND" ||
			normalized === "IGNORE" ||
			normalized === "STOP"
		) {
			return normalized;
		}
		// Defensive default: when malformed, prefer staying engaged (IGNORE bias
		// is dangerous — a missed reply is worse than an unnecessary one).
		return "RESPOND";
	},
};

// ---------------------------------------------------------------------------
// contexts — priority 10. Includes "simple" for direct-reply mode.
// ---------------------------------------------------------------------------

export const contextsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "contexts",
	description:
		'Routing tags from available_contexts. Use ["simple"] only for direct replies needing no tool/action/provider. Owner goals/habits/routines/todos/reminders are never simple; route to tasks/OWNER_* actions. Empty invalid when shouldRespond=RESPOND.',
	descriptionCompressed:
		'Ids from available_contexts. ["simple"]=direct reply, no tools; personal goals/habits/reminders route to tasks/actions.',
	priority: 10,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Context ids from available_contexts. 'simple'=direct reply, no planner.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "").trim();
			if (!normalized) continue;
			const key = normalized.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// intents — priority 15. NEW field.
// ---------------------------------------------------------------------------

export const intentsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "intents",
	description:
		'Short verb phrases covering every explicit outcome requiring runtime actions or external state in this turn. Keep navigation and data changes as separate intents: "open notes and update a note" requires both. Do not discard one clause because another is more substantive. Use [] for ordinary conversation, explanations, or answers fully supplied by replyText; a nonempty intent list requires the planner even if contexts says simple.',
	descriptionCompressed:
		"One verb phrase per requested runtime action, navigation separately from edits. Empty for text-only conversation; nonempty requires planning. Omit no actionable clause.",
	priority: 15,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Every requested outcome as a short verb-led intent, including navigation separately from data changes. Lowercase; no punctuation.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value) {
			const normalized = trimEndCharacters(
				String(item ?? "")
					.trim()
					.toLowerCase(),
				".!?",
			);
			if (!normalized || normalized.length > 80) continue;
			const key = normalized;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// candidateActionNames — priority 50.
// One flat model-facing hint list; downstream retrieval can fan it back out.
// ---------------------------------------------------------------------------

export const candidateActionNamesFieldEvaluator: ResponseHandlerFieldEvaluator<
	string[]
> = {
	name: "candidateActionNames",
	description:
		"Likely UPPER_SNAKE_CASE action names covering all requested intents. Prefer available_actions; confident unlisted names ok. Sticky Notes -> NOTES; UI navigation and native-device operations -> VIEWS; calendar-event reads/writes -> CALENDAR. Opening a view and editing its data require both navigation and data actions, not just one. Life-management (goals/todos/reminders/routines) -> the matching AVAILABLE action (OWNER_REMINDERS, TRIGGER); hint, not a claim. Empty when no action likely.",
	descriptionCompressed:
		"Likely UPPER_SNAKE_CASE actions for every intent. Notes data -> NOTES; navigation/native device -> VIEWS; calendar data -> CALENDAR. Open-and-edit requires both navigation and data actions. Empty only when no action is needed.",
	priority: 50,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"UPPER_SNAKE_CASE retrieval hints covering all intents. Include navigation as well as data actions for open-and-edit requests.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "").trim();
			if (!normalized) continue;
			const key = normalized.toUpperCase();
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// replyText — priority 20.
// Always required. Empty string when routing to planner (planner emits the
// reply via REPLY action). Populate when contexts=["simple"].
// ---------------------------------------------------------------------------

const NAVIGATION_REPLY_RULE =
	'For UI navigation, mention the requested destination in your own concise wording; never use a generic bare acknowledgement such as "On it." as the whole navigation reply. ';

export const replyTextFieldEvaluator: ResponseHandlerFieldEvaluator<string> = {
	name: "replyText",
	description:
		NAVIGATION_REPLY_RULE +
		'User-facing reply. Populate when shouldRespond=RESPOND. contexts includes "simple" => whole answer. Planning/tool path => brief ack only ("On it.", "Spawning the sub-agent now.", "Looking into it."); planner sends grounded follow-up. IGNORE => empty. No thinking/reasoning.\n\nNEVER refuse in replyText on planning path. If `contexts` or `candidateActionNames` != "simple", planner handles work; ack only, no capability gatekeeping. Ban refusal openings: "I cannot...", "I am unable to...", "I don\'t have the ability to...", "Sorry, I can\'t...". Tools exist (FILE, BASH, TASKS_SPAWN_AGENT, etc.). If no tool can attempt, use shouldRespond=RESPOND, `contexts: ["simple"]`, explain.',
	descriptionCompressed:
		"User-facing reply. simple=whole answer; tool/planning path=brief ack, never a refusal; navigation must name its destination; IGNORE=empty string.",
	priority: 20,
	schema: {
		type: "string",
		description:
			"User-facing reply. Simple=whole answer. Planning=brief ack. UI navigation must name the destination instead of using a generic bare acknowledgement. Never refuse on planning path. Plain text unless channel supports markdown.",
	},
	parse(value) {
		if (typeof value !== "string") return "";
		return stripJsonStructuralJunkReply(value);
	},
};

// ---------------------------------------------------------------------------
// replyEffectStatus — priority 25.
// Semantic safety signal for indirect, vague, or non-English completion text.
// ---------------------------------------------------------------------------

/** Normalize the same effect contract in field-registry and fallback parsing. */
export function normalizeReplyEffectStatus(value: unknown): ReplyEffectStatus {
	const normalized =
		typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "applied" ||
		normalized === "non_applied" ||
		normalized === "pending"
		? normalized
		: "none";
}

export const replyEffectStatusFieldEvaluator: ResponseHandlerFieldEvaluator<ReplyEffectStatus> =
	{
		name: "replyEffectStatus",
		description:
			'Classify new work claimed or promised by replyText for the current request, regardless of wording or language. Merely recalling earlier advice, quoting a past action, or reporting an existing fact is not a new effect. "pending" means current-request work is promised, in progress, or not yet completed, including current-information lookup and UI navigation even beside an answered memory question. "applied" means the reply claims a new external change has completed for this request (save, send, schedule, payment, booking, device action, delegated task), including indirect claims such as "on the books" or "quedó listo"; this is not execution proof. "non_applied" means current-request work has a terminal failed, unavailable, cancelled, declined, or preview-only outcome with no promised work remaining. "none" means an answer, explanation, question, or conditional offer without a new work claim, including repeating earlier advice or recalling a previously completed action. Recalling what to bring is none; claiming a newly saved reminder is applied; recalling what to bring while promising to open Home is pending, not none or non_applied.',
		descriptionCompressed:
			"Current-request work status in replyText: pending work (including lookup/navigation), claimed new applied change, terminal non_applied outcome, or none. Recall of earlier advice/actions alone is none; wording and language do not determine routing.",
		priority: 25,
		schema: {
			type: "string",
			enum: ["none", "applied", "non_applied", "pending"],
			description:
				"Classify work for the current request: pending=promised unfinished work, including lookup/navigation beside an answer; applied=claimed newly completed external change, not execution proof; non_applied=terminal failed/unavailable/cancelled/declined/preview outcome with no work remaining; none=answer, explanation, question, or conditional offer without a new work claim. Recalling earlier advice, past completed actions, or existing facts alone is none, not applied.",
		},
		parse: normalizeReplyEffectStatus,
	};

// ---------------------------------------------------------------------------
// facts — priority 80. Memory pipeline.
// ---------------------------------------------------------------------------

export const factsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "facts",
	description:
		'Durable facts explicitly stated in this message about user/world/entities, worth remembering. Examples: "user lives in Brooklyn", "user prefers email over phone", "Bob is Alice\'s coworker at Acme". Skip transient state/current mood. Empty if none.',
	descriptionCompressed:
		"Durable facts stated in this message; skip transient state. Empty if none.",
	priority: 80,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Plain-English facts. One per item. Prefer subject-predicate-object.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "").trim();
			if (!normalized || normalized.length < 4) continue;
			if (result.includes(normalized)) continue;
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// relationships — priority 85. Memory pipeline.
// ---------------------------------------------------------------------------

interface RelationshipTriple {
	subject: string;
	predicate: string;
	object: string;
}

const relationshipsSchema: JSONSchema = {
	type: "array",
	items: {
		type: "object",
		additionalProperties: false,
		properties: {
			subject: {
				type: "string",
				description:
					"Relationship subject: user name, entity name, 'user', or 'agent'.",
			},
			predicate: {
				type: "string",
				description:
					"Relation type. Lowercase verb phrase: works_with, is_friend_of, owns, lives_in.",
			},
			object: {
				type: "string",
				description: "The related entity or value.",
			},
		},
		required: ["subject", "predicate", "object"],
	},
	description:
		"Semantic relationships between entities. Empty array if none stated.",
};

export const relationshipsFieldEvaluator: ResponseHandlerFieldEvaluator<
	RelationshipTriple[]
> = {
	name: "relationships",
	description:
		'Subject-predicate-object triples user stated. Example {"subject":"alice","predicate":"works_with","object":"bob"}. Drives relationship graph. Empty if none.',
	descriptionCompressed:
		"Stated subject-predicate-object triples; empty if none.",
	priority: 85,
	schema: relationshipsSchema,
	parse(value) {
		if (!Array.isArray(value)) return [];
		const result: RelationshipTriple[] = [];
		for (const item of value) {
			if (!item || typeof item !== "object") continue;
			const r = item as Record<string, unknown>;
			const subject = typeof r.subject === "string" ? r.subject.trim() : "";
			const predicate =
				typeof r.predicate === "string" ? r.predicate.trim() : "";
			const object = typeof r.object === "string" ? r.object.trim() : "";
			if (!subject || !predicate || !object) continue;
			result.push({ subject, predicate, object });
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// topics — priority 88. Per-channel topic LRU (extract pipeline).
//
// Emits 1-5 SHORT topic labels for THIS message. Normalized: lowercase,
// trimmed, deduped, empties/overlong dropped, capped at 5. Recorded into
// `ChannelTopicsService` per-room after Stage-1 parse and surfaced back into
// routing via the `CHANNEL_TOPICS` provider so shouldRespond/the planner can
// weigh topic relevance.
// ---------------------------------------------------------------------------

/**
 * Normalize a raw list of topic candidates into lowercase, deduplicated labels.
 * Shared by the field evaluator and the message-handler parse path so both
 * apply identical rules without silently dropping model-produced context.
 */
export function normalizeTopics(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		const normalized = String(item ?? "")
			.trim()
			.toLowerCase()
			.replace(/\s+/g, " ");
		if (!normalized) continue;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

export const topicsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "topics",
	description:
		'1-5 SHORT topic labels for this message (lowercase nouns/noun-phrases): ["billing", "auth bug", "vacation plans"]. NOT verbs/sentences. Tracks what this channel is about over time. Empty when no salient topic.',
	descriptionCompressed:
		"1-5 short lowercase topic labels; empty when no salient topic.",
	priority: 88,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Short topic labels. Lowercase. Nouns/noun-phrases, not verbs.",
	},
	parse(value) {
		return normalizeTopics(value);
	},
};

// ---------------------------------------------------------------------------
// addressedTo — priority 90. Memory pipeline.
// ---------------------------------------------------------------------------

export const addressedToFieldEvaluator: ResponseHandlerFieldEvaluator<
	string[]
> = {
	name: "addressedTo",
	description:
		"Entity UUIDs or participant names addressed by this message. Drives addressed-to graph. Empty when broadcast/unsure.",
	descriptionCompressed:
		"Entity UUIDs/names this message addresses; empty when broadcast/unsure.",
	priority: 90,
	schema: {
		type: "array",
		items: { type: "string" },
		description: "Addressee entity UUIDs preferred; display names ok.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "").trim();
			if (!normalized) continue;
			const key = normalized.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(normalized);
		}
		return result;
	},
};

// ---------------------------------------------------------------------------
// emotion — priority 95. Text-side emotion enum (Stage-1).
//
// Per R3-emotion §2 (Option A): reuse the eliza-1 LM with the existing
// structured-decode singleton-fill path to emit a single emotion label for
// the user's text. Zero additional binary, zero additional download —
// shares the inline-tag vocabulary with the assistant-side
// `expressiveTagPromptClause()`. The value rides on `Content.emotion`
// (`Content` already permits dynamic fields) and the voice-side acoustic
// emotion rides on `MessageMetadata.voice.emotion`. Downstream fusion
// happens in `attributeVoiceEmotion()` so consumers don't reinvent it.
// ---------------------------------------------------------------------------

export const emotionFieldEvaluator: ResponseHandlerFieldEvaluator<ExpressiveEmotionEnumValue> =
	{
		name: "emotion",
		description:
			"User expressed emotion this turn. Single tag: none/happy/sad/angry/nervous/calm/excited/whisper. Default none; use none when ambiguous/no strong cue. Read text + transcript metadata only; do NOT use prior turns. User-side read; assistant emotion uses inline [happy]/[sad]/[excited] tags in replyText when TTS supports.",
		descriptionCompressed:
			"User emotion tag this turn; none when ambiguous/no strong cue.",
		priority: 95,
		schema: {
			type: "string",
			enum: [...EXPRESSIVE_EMOTION_ENUM_VALUES],
			description:
				'User emotion. "none"=no strong cue/default. Other values map to omnivoice expressive tags.',
		},
		parse(value) {
			const normalized =
				typeof value === "string" ? value.trim().toLowerCase() : "";
			if (normalized && isExpressiveEmotionEnumValue(normalized)) {
				return normalized;
			}
			// Defensive default: emit "none" on malformed input — same as the
			// "no strong cue" path. Never throw; the field is advisory.
			return "none";
		},
	};

// ---------------------------------------------------------------------------
// Canonical set — registered at runtime init
// ---------------------------------------------------------------------------

/**
 * Canonical core field evaluators. Registered automatically by the runtime
 * during init (before any plugin registration), so plugin-contributed
 * evaluators see them as siblings.
 */
export const BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS: ReadonlyArray<ResponseHandlerFieldEvaluator> =
	[
		shouldRespondFieldEvaluator,
		contextsFieldEvaluator,
		intentsFieldEvaluator,
		replyTextFieldEvaluator,
		replyEffectStatusFieldEvaluator,
		candidateActionNamesFieldEvaluator,
		factsFieldEvaluator,
		relationshipsFieldEvaluator,
		topicsFieldEvaluator,
		addressedToFieldEvaluator,
		emotionFieldEvaluator,
	];
