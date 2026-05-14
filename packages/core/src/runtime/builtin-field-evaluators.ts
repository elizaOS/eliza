/**
 * Built-in `ResponseHandlerFieldEvaluator`s — the canonical core fields the
 * Stage-1 response handler extracts from every turn.
 *
 * Replaces the legacy nested `HANDLE_RESPONSE_SCHEMA` (processMessage +
 * plan.{contexts, candidateActions, parentActionHints, reply, requiresTool,
 * simple, contextSlices} + thought + extract.{facts, relationships,
 * addressedTo}) with a flat list of typed fields. Each field is an
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

import type { JSONSchema } from "../types/model";
import type { ResponseHandlerFieldEvaluator } from "./response-handler-field-evaluator";

/**
 * Stage-1 envelope `emotion` enum value set — kept in lock-step with
 * `EXPRESSIVE_EMOTION_ENUM` exported from
 * `plugins/plugin-local-inference/src/services/voice/expressive-tags.ts`.
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
		"RESPOND if addressed to you, helpful question, or active conversation. IGNORE if others talking, unaddressed small-talk, not yours. STOP only explicit stop/terminate/no more work. DM usually RESPOND unless explicit stop.",
	priority: 5,
	schema: {
		type: "string",
		enum: ["RESPOND", "IGNORE", "STOP"],
		description:
			"RESPOND=reply/run actions. IGNORE=silent. STOP=explicit user stop.",
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
		'Routing tags. Pick from available_contexts. Use ["simple"] only for trivial direct replies needing no action/tool/provider/sub-agent; replyText is answer. Otherwise choose relevant context ids; planner engages providers/actions. Empty invalid when shouldRespond=RESPOND.',
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
		'Short verb phrases for this turn: ["schedule meeting", "draft email", "research X"]. Use 1-4. Helps action retrieval/routing. Empty for no actionable intent.',
	priority: 15,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Verb-led intents. Lowercase. No punctuation. ~6 words max.",
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value) {
			const normalized = String(item ?? "")
				.trim()
				.toLowerCase()
				.replace(/[.!?]+$/, "");
			if (!normalized || normalized.length > 80) continue;
			const key = normalized;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(normalized);
		}
		return result.slice(0, 8);
	},
};

// ---------------------------------------------------------------------------
// candidateActionNames — priority 50.
// Merges legacy candidateActions + parentActionHints into one flat field.
// ---------------------------------------------------------------------------

export const candidateActionNamesFieldEvaluator: ResponseHandlerFieldEvaluator<
	string[]
> = {
	name: "candidateActionNames",
	description:
		"Likely action names for this turn. Prefer available_actions; confident unlisted names ok (planner resolves similes). Use UPPER_SNAKE_CASE canonical names. Empty when no action likely.",
	priority: 50,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Action names. UPPER_SNAKE_CASE. Retrieval hints; high-precision hits expose planner actions.",
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

export const replyTextFieldEvaluator: ResponseHandlerFieldEvaluator<string> = {
	name: "replyText",
	description:
		'User-facing reply. Populate when shouldRespond=RESPOND. contexts includes "simple" => whole answer. Planning/tool path => brief ack only ("On it.", "Spawning the sub-agent now.", "Looking into it."); planner sends grounded follow-up. IGNORE => empty. No thinking/reasoning.\n\nNEVER refuse in replyText on planning path. If `contexts` or `candidateActionNames` != "simple", planner handles work; ack only, no capability gatekeeping. Ban refusal openings: "I cannot...", "I am unable to...", "I don\'t have the ability to...", "Sorry, I can\'t...". Tools exist (FILE, BASH, TASKS_SPAWN_AGENT, etc.). If no tool can attempt, use shouldRespond=RESPOND, `contexts: ["simple"]`, explain.',
	priority: 20,
	schema: {
		type: "string",
		description:
			'User-facing reply. Simple=whole answer. Planning=brief ack ("On it.", "Working on it.", "Spawning a sub-agent now."). Never refuse on planning path. Plain text unless channel supports markdown.',
	},
	parse(value) {
		if (typeof value !== "string") return "";
		return value.trim();
	},
};

// ---------------------------------------------------------------------------
// facts — priority 80. Memory pipeline.
// ---------------------------------------------------------------------------

export const factsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
	name: "facts",
	description:
		'Durable facts explicitly stated in this message about user/world/entities, worth remembering. Examples: "user lives in Brooklyn", "user prefers email over phone", "Bob is Alice\'s coworker at Acme". Skip transient state/current mood. Empty if none.',
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
		return result.slice(0, 20);
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
		return result.slice(0, 12);
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
		return result.slice(0, 8);
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
			'User expressed emotion this turn. Single tag: none/happy/sad/angry/nervous/calm/excited/whisper. Default none; use none when ambiguous/no strong cue. Read text + transcript metadata only; do NOT use prior turns. User-side read; assistant emotion uses inline [happy]/[sad]/[excited] tags in replyText when TTS supports.',
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
		candidateActionNamesFieldEvaluator,
		factsFieldEvaluator,
		relationshipsFieldEvaluator,
		addressedToFieldEvaluator,
		emotionFieldEvaluator,
	];
