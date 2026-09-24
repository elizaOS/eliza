/**
 * Defines typed response-handler fields and their native schema guidance.
 * Parsers preserve routing, exact-source selection and extraction contracts;
 * plugins may contribute fields through the same registry. Legacy adapters use
 * the corresponding prose descriptions, while native calls carry them once in
 * the tool schema. Empty values represent inapplicable fields.
 */

import type {
  CompletionContextSelection,
  JSONSchema,
  ReplyEffectStatus,
  ResponseHandlerFieldEvaluator,
} from "@elizaos/core";
import {
  ChannelType,
  COMPLETION_CONTEXT_SCHEMA,
  parseCompletionContextSelection,
  stripJsonStructuralJunkReply,
} from "@elizaos/core";

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
    "Respond to addressed conversation and direct follow-ups; apply room policy to ambient/group input. Ignore noise or others' conversation; stop only on explicit disengagement.",
  descriptionCompressed:
    "Respond to addressed conversation and direct follow-ups; apply room policy to ambient/group input. Ignore noise or others' conversation; stop only on explicit disengagement.",
  priority: 5,
  schema: {
    type: "string",
    enum: ["RESPOND", "IGNORE", "STOP"],
    description:
      "Respond to addressed conversation and direct follow-ups; apply room policy to ambient/group input. Ignore noise or others' conversation; stop only on explicit disengagement.",
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
    "Available context IDs for requested work; simple alone means a complete supplied-evidence answer with no pending runtime work.",
  descriptionCompressed:
    "Available context IDs for requested work; simple alone means a complete supplied-evidence answer with no pending runtime work.",
  priority: 10,
  schema: {
    type: "array",
    items: { type: "string" },
    description:
      "Available context IDs for requested work; simple alone means a complete supplied-evidence answer with no pending runtime work.",
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

/** Validate ordered model hints without rewriting their text or dropping outcomes. */
export function readCompleteStringHints(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    return null;
  }
  return [...raw];
}

export const intentsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
  name: "intents",
  description:
    "One verb phrase per requested runtime outcome, including useful prerequisite reads; keep navigation and record changes separate. Empty for complete text-only answers.",
  descriptionCompressed:
    "One verb phrase per requested runtime outcome, including useful prerequisite reads; keep navigation and record changes separate. Empty for complete text-only answers.",
  priority: 15,
  schema: {
    type: "array",
    items: { type: "string" },
    description:
      "One verb phrase per requested runtime outcome, including useful prerequisite reads; keep navigation and record changes separate. Empty for complete text-only answers.",
  },
  parse: readCompleteStringHints,
};

export const contextRequestsFieldEvaluator: ResponseHandlerFieldEvaluator<
  string[]
> = {
  name: "contextRequests",
  description:
    "Exact advertised references needed before deciding; prefer READ_CONTEXT. Otherwise request them here with simple context, empty reply and no action candidates. Reads never execute domain work.",
  descriptionCompressed:
    "Exact advertised references needed before deciding; prefer READ_CONTEXT. Otherwise request them here with simple context, empty reply and no action candidates. Reads never execute domain work.",
  priority: 14,
  schema: {
    type: "array",
    items: { type: "string" },
    description:
      "Exact advertised references needed before deciding; prefer READ_CONTEXT. Otherwise use simple context, empty reply and no action candidates. Reads do not execute domain work.",
  },
  parse: (value) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [],
};

export const completionContextFieldEvaluator: ResponseHandlerFieldEvaluator<
  CompletionContextSelection | undefined
> = {
  name: "completionContext",
  description:
    "Follow the source-selection contract for complete original dialogue, including corrections, constraints and referenced unfinished work; never summarize sources or claim execution.",
  descriptionCompressed:
    "Follow the source-selection contract for complete original dialogue, including corrections, constraints and referenced unfinished work; never summarize sources or claim execution.",
  priority: 16,
  schema: COMPLETION_CONTEXT_SCHEMA,
  parse: parseCompletionContextSelection,
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
    "Optional exact action-name retrieval hints when known; otherwise empty and the planner discovers operations from contexts and intents. Hints grant neither availability nor permission. Exclude hypothetical, prohibited, cancelled or clarification-dependent effects.",
  descriptionCompressed:
    "Optional exact action-name retrieval hints when known; otherwise empty and the planner discovers operations from contexts and intents. Hints grant neither availability nor permission. Exclude hypothetical, prohibited, cancelled or clarification-dependent effects.",
  priority: 50,
  schema: {
    type: "array",
    items: { type: "string" },
    description:
      "Optional exact action-name retrieval hints when known; otherwise empty and the planner discovers operations from contexts and intents. Hints grant neither availability nor permission. Exclude hypothetical, prohibited, cancelled or clarification-dependent effects.",
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
// Always required. Simple turns carry the whole answer; planning turns carry
// an acknowledgement or a held navigation confirmation, never an early effect claim.
// ---------------------------------------------------------------------------

export const replyTextFieldEvaluator: ResponseHandlerFieldEvaluator<string> = {
  name: "replyText",
  description:
    "Complete answer for simple; brief acknowledgment for planned work, without unsupported completion or capability refusal. IGNORE is empty. Navigation-only confirmations name the destination and are held until its receipt, never proving record reads or writes. Exact quotations preserve every character.",
  descriptionCompressed:
    "Complete answer for simple; brief acknowledgment for planned work, without unsupported completion or capability refusal. IGNORE is empty. Navigation-only confirmations name the destination and are held until its receipt, never proving record reads or writes. Exact quotations preserve every character.",
  priority: 20,
  schema: {
    type: "string",
    description:
      "Complete answer for simple; brief acknowledgment for planned work, without unsupported completion or capability refusal. IGNORE is empty. Navigation-only confirmations name the destination and are held until its receipt, never proving record reads or writes. Exact quotations preserve every character.",
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
      "Classify current-request work in the reply: pending=work still to perform; applied=claims a completed change, never proof; non_applied=failed, unavailable, cancelled, declined, preview or awaiting user input; none=no current action decision. Historical recall alone is none.",
    descriptionCompressed:
      "Classify current-request work in the reply: pending=work still to perform; applied=claims a completed change, never proof; non_applied=failed, unavailable, cancelled, declined, preview or awaiting user input; none=no current action decision. Historical recall alone is none.",
    priority: 25,
    schema: {
      type: "string",
      enum: ["none", "applied", "non_applied", "pending"],
      description:
        "Classify current-request work in the reply: pending=work still to perform; applied=claims a completed change, never proof; non_applied=failed, unavailable, cancelled, declined, preview or awaiting user input; none=no current action decision. Historical recall alone is none.",
    },
    parse: normalizeReplyEffectStatus,
  };

// ---------------------------------------------------------------------------
// facts — priority 80. Memory pipeline.
// ---------------------------------------------------------------------------

export const factsFieldEvaluator: ResponseHandlerFieldEvaluator<string[]> = {
  name: "facts",
  description:
    "Durable assertions newly stated by the user in this message only; exclude recalled answers, transient state and facts owned by explicit memory mutations. Preserve fictional framing; empty when none.",
  descriptionCompressed:
    "Durable assertions newly stated by the user in this message only; exclude recalled answers, transient state and facts owned by explicit memory mutations. Preserve fictional framing; empty when none.",
  priority: 80,
  schema: {
    type: "array",
    items: { type: "string" },
    description:
      "Durable assertions newly stated by the user in this message only; exclude recalled answers, transient state and facts owned by explicit memory mutations. Preserve fictional framing; empty when none.",
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
  description:
    "Semantic relationships between entities. Empty array if none stated.",
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
};

export const relationshipsFieldEvaluator: ResponseHandlerFieldEvaluator<
  RelationshipTriple[]
> = {
  name: "relationships",
  description:
    "New user-stated subject/predicate/object relationships; snake_case predicate, empty when none. Exclude relationships owned by explicit memory mutations.",
  descriptionCompressed:
    "New user-stated subject/predicate/object relationships; snake_case predicate, empty when none. Exclude relationships owned by explicit memory mutations.",
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
  shouldRun: ({ message }) =>
    [
      ChannelType.GROUP,
      ChannelType.VOICE_GROUP,
      ChannelType.THREAD,
      ChannelType.WORLD,
      ChannelType.FORUM,
      ChannelType.FEED,
    ].some((type) => type === message.content.channelType),
  description:
    "Short lowercase topic labels for group/social discussion; empty when none.",
  descriptionCompressed:
    "Short lowercase topic labels for group/social discussion; empty when none.",
  priority: 88,
  schema: {
    type: "array",
    items: { type: "string" },
    description:
      "Short lowercase topic labels for group/social discussion; empty when none.",
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
    "Entity UUIDs (preferred) or participant names addressed by this message. Drives addressed-to graph. Empty when broadcast/unsure.",
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
      "Current user emotion from this turn's text/transcript metadata only, never prior turns. One tag: none/happy/sad/angry/nervous/calm/excited/whisper; default none for ambiguous/no strong cue. Assistant emotion instead uses inline [happy]/[sad]/[excited] replyText tags when TTS supports.",
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
    contextRequestsFieldEvaluator,
    intentsFieldEvaluator,
    completionContextFieldEvaluator,
    replyTextFieldEvaluator,
    replyEffectStatusFieldEvaluator,
    candidateActionNamesFieldEvaluator,
    factsFieldEvaluator,
    relationshipsFieldEvaluator,
    topicsFieldEvaluator,
    addressedToFieldEvaluator,
    emotionFieldEvaluator,
  ];

const DIRECT_TEXT_SCHEMA_DESCRIPTIONS = new Map<
  ResponseHandlerFieldEvaluator,
  string | undefined
>([
  [shouldRespondFieldEvaluator, undefined],
  [contextsFieldEvaluator, undefined],
  [intentsFieldEvaluator, undefined],
  [candidateActionNamesFieldEvaluator, undefined],
  [replyTextFieldEvaluator, "Plain text unless channel supports markdown."],
  [factsFieldEvaluator, "One plain-English fact per item."],
  [relationshipsFieldEvaluator, undefined],
  [topicsFieldEvaluator, undefined],
  [addressedToFieldEvaluator, undefined],
  [emotionFieldEvaluator, undefined],
]);

/** Direct-text discovery only: keep full system guidance and nested contracts.
 * Object identity excludes custom fields, including replacements of builtins.
 * Never mutate the registry's cached canonical schema or evaluator objects. */
export function withDirectTextBuiltinSchemaDescriptions(
  schema: JSONSchema,
  registeredFields: readonly ResponseHandlerFieldEvaluator[],
): JSONSchema {
  let properties = schema.properties;
  for (const field of registeredFields) {
    if (
      !DIRECT_TEXT_SCHEMA_DESCRIPTIONS.has(field) ||
      properties?.[field.name] !== field.schema
    )
      continue;
    const compact = { ...field.schema };
    const description = DIRECT_TEXT_SCHEMA_DESCRIPTIONS.get(field);
    if (description === undefined) delete compact.description;
    else compact.description = description;
    properties = { ...properties, [field.name]: compact };
  }
  return properties === schema.properties ? schema : { ...schema, properties };
}
