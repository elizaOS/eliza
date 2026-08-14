/**
 * Declares the deterministic owner-reminder creation boundary so explicit
 * “remind me” requests reach the definition-owning OWNER_REMINDERS surface.
 * Core still applies role, capability-tag, connector, and action validation
 * gates before promoting the turn to planning.
 */

import type { DirectActionRoutingRule } from "@elizaos/core";

const REMINDER_CREATE_PATTERNS: readonly RegExp[] = [
  /^remind\s+(?:me|myself)\b[\s\S]{0,120}\b(?:to|about|in|at|on|by|for|every|each|tomorrow|tonight|today|next)\b/iu,
  /^(?:add|create|schedule|set)\s+(?:(?:me|my)\s+)?(?:an?\s+)?reminder\b/iu,
  /^(?:don['’]?t|do\s+not)\s+forget\s+to\s+(?:please\s+)?remind\s+(?:me|myself)\b[\s\S]{0,120}\b(?:to|about|in|at|on|by|for|every|each|tomorrow|tonight|today|next)\b/iu,
];

const DIRECT_REQUEST_LEAD_IN =
  /^(?:(?:(?:hey|hi|hello)(?:\s+[\p{L}'’-]+)?[,!]|(?:okay|ok|alright|also|and|then)[,!]?|please|(?:can|could|would|will)\s+you(?:\s+please)?|i\s+(?:need|want)\s+(?:you\s+)?to|i(?:['’]d|\s+would)\s+like\s+(?:you\s+)?to|i\s+was\s+hoping\s+you\s+could|help\s+me)\s+)+/iu;

const REMINDER_META_PREFIX =
  /^(?:(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:what|when|where|who|why|how|is|are|explain|define|tell me(?: about| how| what| whether| if)|give (?:me )?an? example|write (?:a )?story|tell (?:me )?a story|quote)|(?:suppose|imagine|if i say)|(?:in|as)\s+(?:(?:this|that|an?|the)\s+)?(?:example|story|quote))\b/iu;
const REMINDER_META_SUFFIX =
  /\b(?:remind\s+me|(?:add|create|schedule|set)\s+(?:(?:me|my)\s+)?(?:an?\s+)?reminder)\b[\s\S]{0,120}\b(?:is|was|would be)\s+(?:an?\s+|the\s+)?(?:example|command|phrase|quote|syntax)\b/iu;
const REMINDER_META_CONTEXT =
  /\b(?:explain|describe|define|know|understand|tell\s+me)\b[\s\S]{0,60}\b(?:how|what|whether|meaning|phrase|command|syntax|words?)\b[\s\S]{0,80}\b(?:remind\s+(?:me|myself)|(?:add|create|schedule|set)\s+(?:(?:me|my)\s+)?(?:an?\s+)?reminder)\b/iu;
const REMINDER_NEGATION =
  /\b(?:don['’]?t|do not|never|no longer|stop|cancel|remove|delete|disable|skip)\b(?![\s\S]{0,20}\bforget\b)[\s\S]{0,60}\b(?:remind(?:er)?|remind\s+(?:me|myself))\b|\bremind\s+(?:me|myself)\b[\s\S]{0,40}\b(?:not|don['’]?t|do not|never|cancel|stop)\b/iu;
const REMINDER_RECALL =
  /\bremind\s+(?:me|myself)\b[\s\S]{0,50}\b(?:what|when|where|who|why|how|if|whether)\b/iu;
const THIRD_PARTY_REMINDER =
  /\bremind\s+(?!me\b|myself\b)(?:him|her|them|us|my\b|[A-Za-z][\p{L}'’-]*)\b/iu;
const MIXED_RECIPIENT_REMINDER =
  /\bremind\s+(?:me|myself)(?:\s+(?:and|&|plus)\s+(?!me\b|myself\b)[\p{L}]|\s*,\s*[\p{Lu}][\p{L}'’-]*(?:\s*,|\s+(?:and|&|to)\b))/iu;
const QUOTED_REMINDER =
  /["“”‘’`]([^"“”‘’`]*\b(?:remind\s+(?:me|myself)|add\s+(?:an?\s+)?reminder|create\s+(?:an?\s+)?reminder|set\s+(?:an?\s+)?reminder|schedule\s+(?:an?\s+)?reminder)\b[^"“”‘’`]*)["“”‘’`]/iu;

export function looksLikeOwnerReminderCreateRequest(text: string): boolean {
  const normalized = text.trim();
  const directRequest = normalized.replace(DIRECT_REQUEST_LEAD_IN, "");
  return (
    normalized.length > 0 &&
    !REMINDER_META_PREFIX.test(normalized) &&
    !REMINDER_META_SUFFIX.test(normalized) &&
    !REMINDER_META_CONTEXT.test(normalized) &&
    !REMINDER_NEGATION.test(normalized) &&
    !REMINDER_RECALL.test(normalized) &&
    !THIRD_PARTY_REMINDER.test(normalized) &&
    !MIXED_RECIPIENT_REMINDER.test(normalized) &&
    !QUOTED_REMINDER.test(normalized) &&
    REMINDER_CREATE_PATTERNS.some((pattern) => pattern.test(directRequest))
  );
}

export function createOwnerReminderDirectRoutingRule(): DirectActionRoutingRule {
  return {
    id: "lifeops.owner-reminder-create",
    actionNames: ["OWNER_REMINDERS"],
    replacesActionNames: ["TRIGGER_CREATE"],
    requiredActionTags: [
      "domain:reminders",
      "capability:write",
      "capability:schedule",
      "effect:receipt-required",
    ],
    contexts: ["tasks", "productivity"],
    matches: looksLikeOwnerReminderCreateRequest,
  };
}
