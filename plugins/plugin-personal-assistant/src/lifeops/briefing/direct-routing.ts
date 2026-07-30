/**
 * Declarative direct-route contract for owner day/week recap requests.
 * The matcher distinguishes live tracked-work reads from literal visible-chat
 * recall, while core verifies that the named BRIEF action is role-eligible,
 * validated, and tagged as a tracked-work reader before forcing planning.
 */

import type { DirectActionRoutingRule } from "@elizaos/core";

const VISIBLE_CHAT_RECALL =
  /\b(?:in|from|of)\s+(?:this|our|the)\s+(?:chat|conversation|thread)\b|\b(?:what|which)\s+(?:did|have)\s+i\s+(?:say|said|mention|mentioned|write|wrote|paste|pasted|tell|told)\b|\bwhat\s+i\s+(?:just\s+)?(?:said|wrote|pasted|mentioned)\b|\b(?:messages?|text|content)\s+(?:i\s+)?(?:just\s+)?(?:pasted|above)\b|\brecap\s+(?:our|this|the)\s+(?:chat|conversation|thread)\b/iu;

const TRACKED_WORK_RECAP_PATTERNS: readonly RegExp[] = [
  /\b(?:recap|summari[sz]e|review|overview|digest|status)\b[\s\S]{0,60}\b(?:my|today|tonight|yesterday|day|week|tasks?|todos?|to[- ]dos?|reminders?|habits?|routines?|goals?|work|progress)\b/iu,
  /\b(?:what|which)\s+(?:did|have)\s+i\s+(?:get\s+done|finish(?:ed)?|complete(?:d)?|accomplish(?:ed)?)\b/iu,
  /\bwhat(?:'s|\s+is)\s+(?:left|remaining|still\s+open|unfinished|outstanding)\s+(?:today|tonight|this\s+week|on\s+my\s+(?:list|tasks?|todos?)|to\s+do)\b|\bwhich\s+tasks?\s+are\s+(?:left|remaining|still\s+open|unfinished|outstanding)\b/iu,
  /\b(?:did|have)\s+i\s+(?:finish|finished|complete|completed)\s+(?:everything|all\s+(?:my\s+)?(?:tasks?|todos?|work))\b/iu,
  /\bhow\s+did\s+i\s+do\s+(?:today|tonight|yesterday|this\s+week|last\s+week)\b/iu,
  /\bshow\s+me\s+(?:my\s+)?(?:completed|finished|open|remaining|outstanding)\s+(?:tasks?|todos?|work)\b/iu,
];

export function looksLikeTrackedWorkRecapRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || VISIBLE_CHAT_RECALL.test(normalized)) {
    return false;
  }
  return TRACKED_WORK_RECAP_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function createTrackedWorkRecapDirectRoutingRule(): DirectActionRoutingRule {
  return {
    id: "lifeops.tracked-work-recap",
    actionNames: ["BRIEF"],
    requiredActionTags: [
      "domain:briefing",
      "resource:tracked-work",
      "capability:read",
    ],
    contexts: ["briefing", "tasks"],
    matches: looksLikeTrackedWorkRecapRequest,
  };
}
