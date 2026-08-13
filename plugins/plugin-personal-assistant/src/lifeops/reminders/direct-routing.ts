/**
 * Declares the deterministic owner-reminder creation boundary so explicit
 * “remind me” requests reach the definition-owning OWNER_REMINDERS surface.
 * Core still applies role, capability-tag, connector, and action validation
 * gates before promoting the turn to planning.
 */

import type { DirectActionRoutingRule } from "@elizaos/core";

const EXPLICIT_REMINDER_CREATE_PATTERNS: readonly RegExp[] = [
  /\bremind\s+me\b/iu,
  /\b(?:add|create|schedule|set)\s+(?:me\s+)?(?:an?\s+)?reminder\b/iu,
];

export function looksLikeOwnerReminderCreateRequest(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.length > 0 &&
    EXPLICIT_REMINDER_CREATE_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    )
  );
}

export function createOwnerReminderDirectRoutingRule(): DirectActionRoutingRule {
  return {
    id: "lifeops.owner-reminder-create",
    actionNames: ["OWNER_REMINDERS"],
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
