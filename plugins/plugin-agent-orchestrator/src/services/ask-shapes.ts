/** Shapes of a user ask the orchestrator routes on structurally. */

/** "also …", "add … to it", "make it …": an instruction about work already
 *  under way, not a new deliverable. */
export const FOLLOW_UP_SHAPE_RE =
  /^\s*(?:oh\s+|and\s+)?(?:also|plus|btw|additionally)\b|\b(?:to|on|in|for|into)\s+(?:it|that|the\s+(?:page|app|site|script))\b|\bmake\s+it\b|\bit\s+(?:too|as\s+well)\b/i;

/** "make me a page …", "another script …": a new deliverable, even when the
 *  sentence also says "on it" / "run it". */
export const NEW_DELIVERABLE_RE =
  /\b(?:make|build|create|write|spin\s+up)\s+(?:me\s+)?(?:a|an|another|new|two|three|\d+)\b[^.!?\n]{0,40}\b(?:pages?|apps?|sites?|scripts?|games?|tools?|widgets?)\b/i;

export function looksLikeNewDeliverableAsk(text: string): boolean {
  return NEW_DELIVERABLE_RE.test(text);
}

/** "like that", "of it", "than this": the sentence leans on prior work even
 *  when it names a new deliverable. */
export const ANAPHOR_RE =
  /\b(?:like|of|for|than|as|to)\s+(?:it|that|this)\b|\bthe\s+(?:last|previous|earlier)\s+one\b/i;
