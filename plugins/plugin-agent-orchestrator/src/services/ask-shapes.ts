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

/** "hows it coming", "is it done yet", "any update?", "wheres my link":
 * a PROGRESS QUESTION about in-flight work. Never a fold candidate — folding
 * one forwards the question to the worker as a build instruction (live
 * 2026-08-24: "hows the pomodoro coming along?" folded into the lane and a
 * second copy of the app deployed). Status routing owns these. An
 * interrogative only counts when the text carries no imperative content, so
 * "hows it going? also make the button red" still folds. */
const STATUS_INQUIRY_RE =
  /^\s*(?:hey\s+|ok\s+|so\s+)?(?:hows?|how\s+is|how're|is\s+(?:it|that|the)\b|are\s+(?:you|we)\b|wheres?\b|where\s+is|whats?\s+the\s+(?:status|progress|eta|holdup)|any\s+(?:update|progress|news|luck)|(?:is\s+it\s+)?done\s+yet|eta\b|still\s+(?:working|going|building))/i;

const IMPERATIVE_CONTENT_RE =
  /\b(?:add|make|change|fix|use|switch|set|remove|delete|rename|deploy|redeploy|rebuild|update\s+(?:the|it|that|this)|restyle|resize|move|put|turn|give\s+it|instead)\b/i;

export function looksLikeStatusInquiry(text: string): boolean {
  return STATUS_INQUIRY_RE.test(text) && !IMPERATIVE_CONTENT_RE.test(text);
}
