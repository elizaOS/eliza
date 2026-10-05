/**
 * Declares the deterministic owner-reminder creation boundary so explicit
 * “remind me” requests reach the definition-owning OWNER_REMINDERS surface.
 * Core still applies role, capability-tag, connector, and action validation
 * gates before promoting the turn to planning.
 */

import {
  type DirectActionRoutingRule,
  extractUserText,
  getUserMessageText,
  isObjectRecord,
  type ResponseHandlerEvaluator,
  validateUuid,
} from "@elizaos/core";

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
  /\b(?:remind\s+me|(?:add|create|schedule|set)\s+(?:(?:me|my)\s+)?(?:an?\s+)?reminder)\b[\s\S]{0,120}\b(?:is|was|would be)\s+(?:an?\s+|the\s+)?(?:(?:sample|example|test|valid|invalid)\s+)?(?:example|command|phrase|quote|syntax)\b/iu;
const REMINDER_META_CONTEXT =
  /\b(?:explain|describe|define|know|understand|tell\s+me)\b[\s\S]{0,60}\b(?:how|what|whether|meaning|phrase|command|syntax|words?)\b[\s\S]{0,80}\b(?:remind\s+(?:me|myself)|(?:add|create|schedule|set)\s+(?:(?:me|my)\s+)?(?:an?\s+)?reminder)\b/iu;
const REMINDER_NEGATION =
  /\b(?:don['’]?t|do not|never|no longer|stop|cancel|remove|delete|disable|skip)\b(?![\s\S]{0,20}\bforget\b)[\s\S]{0,60}\b(?:remind(?:er)?|remind\s+(?:me|myself))\b|\bremind\s+(?:me|myself)\b[\s\S]{0,40}\b(?:not|don['’]?t|do not|never|cancel|stop)\b/iu;
const REMINDER_RECALL =
  /\bremind\s+(?:me|myself)\s+(?:what|when|where|who|why|how|if|whether)\b/iu;
const THIRD_PARTY_REMINDER =
  /\bremind\s+(?!me\b|myself\b)(?:him|her|them|us|my\b|[A-Za-z][\p{L}'’-]*)\b/iu;
const MIXED_RECIPIENT_REMINDER =
  /\bremind\s+(?:me|myself)(?:\s*,?\s*(?:(?:and|&|plus|as\s+well\s+as)\s+|(?:along|together)\s+with\s+)(?!me\b|myself\b)(?:@|<@|\d|[\p{L}])|\s*,\s*[\p{Lu}][\p{L}'’-]*(?:\s*,|\s+(?:and|&|to)\b))/iu;
const QUOTED_REMINDER =
  /["“”‘’`]([^"“”‘’`]*\b(?:remind\s+(?:me|myself)|add\s+(?:an?\s+)?reminder|create\s+(?:an?\s+)?reminder|set\s+(?:an?\s+)?reminder|schedule\s+(?:an?\s+)?reminder)\b[^"“”‘’`]*)["“”‘’`]/iu;
const REPORTED_REMINDER =
  /\bremind\s+(?:me|myself)\b[\s\S]{0,160}(?:,\s*(?:said|wrote|asked|replied)\s+[\p{L}]|\b(?:those|these|that)\s+(?:are|were)\s+(?:[\p{L}'’-]+['’]s\s+)?exact\s+words\b|\b(?:appears?|appeared|is|was)\s+(?:(?:written|posted|printed|displayed|shown)\s+)?(?:on|in)\b\s+(?:an?\s+|the\s+)?(?:whiteboard|screen|document|example|story|quote)\b)/iu;
const RESCINDED_REMINDER =
  /\bremind\s+(?:me|myself)\b[\s\S]{0,160}(?:[;,—-]\s*(?:actually\s+)?(?:disregard|ignore|cancel|scratch|withdraw|forget)\b(?:\s+(?:it|this|that)(?:\s+request)?)?|\bnever\s+mind\b)/iu;

export function isOwnerReminderNonCommandContext(text: string): boolean {
  const normalized = text.trim();
  return (
    REMINDER_META_PREFIX.test(normalized) ||
    REMINDER_META_SUFFIX.test(normalized) ||
    REMINDER_META_CONTEXT.test(normalized) ||
    THIRD_PARTY_REMINDER.test(normalized) ||
    MIXED_RECIPIENT_REMINDER.test(normalized) ||
    QUOTED_REMINDER.test(normalized) ||
    REPORTED_REMINDER.test(normalized) ||
    RESCINDED_REMINDER.test(normalized)
  );
}

export function looksLikeOwnerReminderCreateRequest(text: string): boolean {
  const normalized = text.trim();
  const directRequest = normalized.replace(DIRECT_REQUEST_LEAD_IN, "");
  return (
    normalized.length > 0 &&
    !isOwnerReminderNonCommandContext(normalized) &&
    !REMINDER_NEGATION.test(normalized) &&
    !REMINDER_RECALL.test(normalized) &&
    REMINDER_CREATE_PATTERNS.some((pattern) => pattern.test(directRequest))
  );
}

export function createOwnerReminderDirectRoutingRule(): DirectActionRoutingRule {
  return {
    id: "lifeops.owner-reminder-create",
    actionNames: ["OWNER_REMINDERS"],
    replacesActionNames: ["TRIGGER", "TRIGGER_CREATE"],
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

/** Typed control replies select a route; the action still authorizes the effect. */
export const ownerReminderChoiceDirectRoutingRules: readonly DirectActionRoutingRule[] =
  [
    ["done", "OWNER_REMINDERS_COMPLETE"],
    ["skip", "OWNER_REMINDERS_SKIP"],
    ["10 minutes", "OWNER_REMINDERS_SNOOZE"],
  ].map<DirectActionRoutingRule>(([value, actionName]) => ({
    id: `lifeops.owner-reminder-choice.${actionName}`,
    actionNames: [actionName],
    requiredActionTags: [
      "domain:reminders",
      "capability:write",
      "effect:receipt-required",
    ],
    contexts: ["tasks", "productivity"],
    unavailable: {
      code: "OWNER_REMINDER_CHOICE_UNAVAILABLE",
      reply: "I can't apply that reminder choice in this context.",
    },
    matches: (text, message) => {
      const metadata = message?.content.metadata;
      return Boolean(
        isObjectRecord(metadata) &&
          typeof metadata.reminderChoiceId === "string" &&
          metadata.reminderChoiceId.trim() &&
          validateUuid(message?.content.inReplyTo) &&
          extractUserText(text) === value,
      );
    },
  }));

export const ownerReminderChoiceRoutingEvaluator: ResponseHandlerEvaluator = {
  name: "lifeops.bound-reminder-choice",
  // Own the typed envelope after the current core/PA routing enrichers (<=30).
  priority: 100,
  deterministicActions: ownerReminderChoiceDirectRoutingRules.flatMap(
    (rule) => rule.actionNames,
  ),
  shouldRun: ({ message }) =>
    isObjectRecord(message.content.metadata) &&
    Object.hasOwn(message.content.metadata, "reminderChoiceId"),
  evaluate: ({ message, messageHandler }) => {
    const route = ownerReminderChoiceDirectRoutingRules.find(
      (rule) =>
        rule.matches(getUserMessageText(message), message) &&
        messageHandler.plan.candidateActions?.includes(rule.actionNames[0]),
    );
    if (
      !route ||
      messageHandler.processMessage !== "RESPOND" ||
      messageHandler.plan.requiresTool !== true
    ) {
      return {
        processMessage: "RESPOND",
        requiresTool: false,
        replyEffectStatus: "non_applied",
        setContexts: ["simple"],
        clearCandidateActions: true,
        clearParentActionHints: true,
        clearReply: true,
        reply:
          "I can't apply that reminder choice in this context. Open the current reminder and try again.",
      };
    }
    // Priority 15's core route evaluator admitted this exact capability through
    // actor/tag/context/connector/validate gates. Use its existing executor,
    // which retains source validation; never ask a planner to discover it again.
    return {
      requiresTool: true,
      clearReply: true,
      deterministicToolCall: { name: route.actionNames[0], params: {} },
    };
  },
};
