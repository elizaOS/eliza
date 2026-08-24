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

/** Deliverable-category nouns a doneness question names ("the color PAGE",
 *  "my tracker APP"). Arbitrary app NAMES ("is daily hue done?") carry none —
 *  the routing evaluator grounds those against known task labels instead. */
export const DELIVERABLE_NOUN_RE =
  /\b(?:pages?|apps?|sites?|websites?|web\s*apps?|builds?|scripts?|games?|tools?|widgets?|dashboards?|trackers?|projects?|deployments?)\b/i;

/** "is … done", "did … finish", "… ready yet?", "has it deployed":
 *  completion-oriented phrasing, interrogative forms only. */
const DONENESS_PHRASE_RE =
  /\b(?:is|are|was)\b[^.!?\n]{0,60}\b(?:done|finished|ready|complete|completed|live|deployed|up\s+yet)\b|\b(?:did|has|have)\b[^.!?\n]{0,60}\b(?:finish(?:ed)?|deploy(?:ed)?|complete(?:d)?|ship(?:ped)?|go(?:ne)?\s+live)\b|\b(?:done|ready|finished|live)\s+yet\b/i;

/** "wheres my link", "link me", "whats the url": the user is asking for the
 *  deliverable's link — a completion question in link's clothing. */
const LINK_ASK_RE =
  /\bwheres?\s+(?:my|the)\s+link\b|\bwhere\s+is\s+(?:my|the)\s+link\b|\blink\s+me\b|\bwhats?\s+the\s+(?:link|url)\b|\b(?:send|give|drop|get)\s+(?:me\s+)?(?:my|the)\s+link\b/i;

/** Interrogative deploy/build phrasing ("did the app deploy?") that must not
 *  trip the imperative gate's deploy/build tokens. */
const INTERROGATIVE_COMPLETION_VERB_RE =
  /\b(?:did|has|have|is|are|was|were)\b[^.!?\n]{0,60}\b(?:deploy(?:ed)?|rebuil[dt]|build|built)\b/gi;

/** "is the color page done? link me", "did the tracker app finish?",
 * "wheres my link": a DONENESS/COMPLETION question about a deliverable. These
 * must answer from the durable task record (the TASKS history surface), never
 * from an app-catalog listing — routed as APP+LIST_CLOUD_APPS, "is the color
 * page done? link me" dumped a 10-app catalog instead of answering (live
 * 2026-08-21). Imperative content disqualifies ("is it done? also make the
 * button red" keeps its normal routing), mirroring looksLikeStatusInquiry. */
export function looksLikeDonenessInquiry(text: string): boolean {
  const scrubbed = text.replace(INTERROGATIVE_COMPLETION_VERB_RE, " ");
  if (IMPERATIVE_CONTENT_RE.test(scrubbed)) return false;
  // "build a pomodoro app and link me when done" is a NEW build ask that
  // happens to mention its own completion — never a doneness question.
  if (NEW_DELIVERABLE_RE.test(text)) return false;
  if (LINK_ASK_RE.test(text)) return true;
  return (
    DONENESS_PHRASE_RE.test(text) ||
    (STATUS_INQUIRY_RE.test(text) && DELIVERABLE_NOUN_RE.test(text))
  );
}
