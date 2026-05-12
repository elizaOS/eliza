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

// ---------------------------------------------------------------------------
// shouldRespond — priority 5 (always first)
// ---------------------------------------------------------------------------

export const shouldRespondFieldEvaluator: ResponseHandlerFieldEvaluator<
	"RESPOND" | "IGNORE" | "STOP"
> = {
	name: "shouldRespond",
	description:
		"Decide whether to respond to this message. RESPOND when the message is addressed to you, asks a question you can help with, or continues an active conversation. IGNORE when the message is between other people, is small-talk you were not addressed in, or is otherwise not yours to handle. STOP only when the user explicitly asks you to stop/terminate this interaction without further work. In a DM channel this is effectively always RESPOND unless the user asks you to stop.",
	priority: 5,
	schema: {
		type: "string",
		enum: ["RESPOND", "IGNORE", "STOP"],
		description:
			"RESPOND = engage this turn (compose reply or run actions). IGNORE = stay silent and let the conversation continue without you. STOP = terminate because the user explicitly asked you to stop.",
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
		'Routing tags for this turn. Pick from the available_contexts catalog earlier in this prompt. Use ["simple"] for trivial replies that don\'t need any action / tool / provider / sub-agent (just put the reply text in replyText). Use one or more context tags otherwise — the planner will engage the matching providers and actions. Empty array is invalid when shouldRespond=RESPOND — pick at least one.',
	priority: 10,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Context tags. Must match available_contexts. The pseudo-context 'simple' means direct-reply (no planner needed).",
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
		'Short verb phrases describing what the user is asking for this turn. Use 1-4 phrases like ["schedule meeting", "draft email", "research X"]. Useful for action retrieval and routing classification. Empty array when there is no actionable intent (e.g. simple acknowledgement).',
	priority: 15,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Verb-led intent phrases. Lowercase. No punctuation. Max ~6 words each.",
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
		"Action names you would likely use this turn. Match values to the available_actions list earlier in this prompt — but it is fine to emit a name you are confident about even if it is not listed (the planner will resolve via similes). Use UPPER_SNAKE_CASE for canonical action names. Empty array when no actions are likely needed (e.g. simple chitchat).",
	priority: 50,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Action names. UPPER_SNAKE_CASE. The planner uses this for retrieval; high-precision hits land in the planner's exposed action surface.",
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
		'The user-facing reply text. Always populate it when shouldRespond=RESPOND. When contexts contains "simple", this is the whole answer. When planning/tool work is needed, make this a brief acknowledgement that can be sent immediately; the planner will send any grounded follow-up later. Leave empty for IGNORE. Do NOT put thinking or reasoning here; keep it user-facing.',
	priority: 20,
	schema: {
		type: "string",
		description:
			"User-facing reply text. Whole answer for simple turns; brief immediate acknowledgement for planning turns. Plain text, not markdown unless the channel supports it.",
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
		'Durable facts about the user, the world, or named entities that the user has explicitly stated in this message and that should be remembered going forward. Examples: "user lives in Brooklyn", "user prefers email over phone", "Bob is alice\'s coworker at Acme". Skip transient state (current location, today\'s mood) — only durable. Empty array if nothing memorable.',
	priority: 80,
	schema: {
		type: "array",
		items: { type: "string" },
		description:
			"Plain-English fact statements. One fact per array item. Subject-predicate-object structure preferred but not required.",
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
					"The entity the relationship is about. Use the user's name, an entity name, or 'user' / 'agent'.",
			},
			predicate: {
				type: "string",
				description:
					"The relation type. Lowercase verb phrase like 'works_with', 'is_friend_of', 'owns', 'lives_in'.",
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
		'Subject-predicate-object triples the user stated about entities and their relationships. Example: {"subject":"alice","predicate":"works_with","object":"bob"}. Drives the relationship graph. Empty array if nothing relational is stated.',
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
		"Entity UUIDs or participant names this message is directed at. Drives the addressed-to relationship graph. Empty array when the message is broadcast or you are unsure.",
	priority: 90,
	schema: {
		type: "array",
		items: { type: "string" },
		description: "Entity UUIDs (preferred) or display names of the addressees.",
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
	];
