/**
 * Declares the deterministic owner-reminder creation boundary so explicit
 * “remind me” requests reach the definition-owning OWNER_REMINDERS surface.
 * Core still applies role, capability-tag, connector, and action validation
 * gates before promoting the turn to planning.
 */

import type { DirectActionRoutingRule } from "@elizaos/core";

const REMINDER_CREATE_PATTERNS: readonly RegExp[] = [
  /\bremind\s+me\b[\s\S]{0,120}\b(?:to|about|in|at|on|by|for|every|each|tomorrow|tonight|today|next)\b/iu,
  /\b(?:add|create|schedule|set)\s+(?:(?:me|my)\s+)?(?:an?\s+)?reminder\b/iu,
];

const REMINDER_META_PREFIX =
  /^(?:(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:what|when|where|who|why|how|is|are|explain|define|tell me(?: about| how| what| whether| if)|give (?:me )?an? example|write (?:a )?story|tell (?:me )?a story|quote)|(?:suppose|imagine|if i say)|(?:in|as)\s+(?:(?:this|that|an?|the)\s+)?(?:example|story|quote))\b/iu;
const REMINDER_META_SUFFIX =
  /\b(?:remind\s+me|(?:add|create|schedule|set)\s+(?:(?:me|my)\s+)?(?:an?\s+)?reminder)\b[\s\S]{0,120}\b(?:is|was|would be)\s+(?:an?\s+|the\s+)?(?:example|command|phrase|quote|syntax)\b/iu;
const REMINDER_NEGATION =
  /\b(?:don['’]?t|do not|never|no longer|stop|cancel|remove|delete|disable|skip)\b[\s\S]{0,60}\b(?:remind(?:er)?|remind\s+me)\b|\bremind\s+me\b[\s\S]{0,40}\b(?:not|don['’]?t|do not|never|cancel|stop)\b/iu;
const REMINDER_RECALL =
  /\bremind\s+me\b[\s\S]{0,50}\b(?:what|when|where|who|why|how|if|whether)\b/iu;
const THIRD_PARTY_REMINDER =
  /\bremind\s+(?!me\b)(?:him|her|them|us|my\b|[A-Za-z][\p{L}'’-]*)\b/iu;
const QUOTED_REMINDER =
  /["“”‘’`]([^"“”‘’`]*\b(?:remind\s+me|add\s+(?:an?\s+)?reminder|create\s+(?:an?\s+)?reminder|set\s+(?:an?\s+)?reminder|schedule\s+(?:an?\s+)?reminder)\b[^"“”‘’`]*)["“”‘’`]/iu;

export function looksLikeOwnerReminderCreateRequest(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.length > 0 &&
    !REMINDER_META_PREFIX.test(normalized) &&
    !REMINDER_META_SUFFIX.test(normalized) &&
    !REMINDER_NEGATION.test(normalized) &&
    !REMINDER_RECALL.test(normalized) &&
    !THIRD_PARTY_REMINDER.test(normalized) &&
    !QUOTED_REMINDER.test(normalized) &&
    REMINDER_CREATE_PATTERNS.some((pattern) => pattern.test(normalized))
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
