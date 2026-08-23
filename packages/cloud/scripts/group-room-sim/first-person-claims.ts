/**
 * First-person attribution for the forbidden-claim sweep. The homepage's
 * UNSUPPORTED_CLAIM_RULES guard a fixed marketing script, so they fire on
 * bare vocabulary ("send", "buy", "workspace") no matter whose verb it is. A
 * live reply is scored more narrowly: a rule hit counts only inside a
 * FIRST-PERSON SPAN, a stretch of one sentence in which Eliza is asserting
 * or offering her own capability. The rules stay untouched (they are the
 * homepage's); this module only decides which stretches they run over.
 *
 * A span opens at a first-person marker (FIRST_PERSON_MARKER) and closes at
 * the end of the sentence or at the first subject switch after it
 * (PRONOUN_SWITCH, NAME_SWITCH), whichever comes first. Sentences split on
 * line breaks and terminal punctuation; checkbox items ("[ ] Buy coffee")
 * and double-quoted or backticked text are masked out first, so a todo
 * receipt or a quoted human line never counts.
 *
 * Accepted blind spots, traded for precision: third-person self-reference
 * ("Eliza can book"), elided verbs outside the explicit completion list and
 * unlisted action verbs ("I snagged a table") open no span.
 */

/**
 * Verbs that make a bare "I <verb>" an assertion of something Eliza did:
 * the actions behind the homepage's claim categories (send, book, buy,
 * search, save, run...) plus generic completion verbs. Base and past forms;
 * "-ing" forms ride on the "I'm" marker.
 */
const ACTION_VERBS: readonly string[] = [
  "add",
  "added",
  "arrange",
  "arranged",
  "book",
  "booked",
  "bought",
  "buy",
  "call",
  "called",
  "cancel",
  "canceled",
  "cancelled",
  "change",
  "changed",
  "check",
  "checked",
  "clear",
  "cleared",
  "compile",
  "compiled",
  "complete",
  "completed",
  "confirm",
  "confirmed",
  "connect",
  "connected",
  "create",
  "created",
  "delete",
  "deleted",
  "deploy",
  "deployed",
  "did",
  "dm",
  "dm'd",
  "dmed",
  "do",
  "download",
  "downloaded",
  "email",
  "emailed",
  "execute",
  "executed",
  "file",
  "filed",
  "find",
  "finish",
  "finished",
  "fix",
  "fixed",
  "flag",
  "flagged",
  "forward",
  "forwarded",
  "found",
  "grab",
  "grabbed",
  "got",
  "handle",
  "handled",
  "keep",
  "kept",
  "link",
  "linked",
  "lock",
  "locked",
  "log",
  "logged",
  "look",
  "looked",
  "made",
  "make",
  "mark",
  "marked",
  "message",
  "messaged",
  "move",
  "moved",
  "note",
  "noted",
  "open",
  "opened",
  "order",
  "ordered",
  "organize",
  "organized",
  "paid",
  "pay",
  "pin",
  "pinned",
  "place",
  "placed",
  "post",
  "posted",
  "pull",
  "pulled",
  "purchase",
  "purchased",
  "push",
  "pushed",
  "put",
  "queue",
  "queued",
  "ran",
  "read",
  "register",
  "registered",
  "remember",
  "remembered",
  "remind",
  "reminded",
  "remove",
  "removed",
  "research",
  "researched",
  "reschedule",
  "rescheduled",
  "reserve",
  "reserved",
  "run",
  "save",
  "saved",
  "schedule",
  "scheduled",
  "search",
  "searched",
  "secure",
  "secured",
  "select",
  "selected",
  "send",
  "sent",
  "set",
  "share",
  "shared",
  "sign",
  "signed",
  "sort",
  "sorted",
  "start",
  "started",
  "store",
  "stored",
  "submit",
  "submitted",
  "sync",
  "synced",
  "text",
  "texted",
  "track",
  "tracked",
  "update",
  "updated",
  "upload",
  "uploaded",
  "use",
  "used",
  "write",
  "wrote",
];

const MODALS = "can|could|will|would|shall|should|may|might|must";
/** "I can" must not be the head of "I can't" / "I cannot" / "I can never". */
const NOT_NEGATED = "(?!n't|'t|\\s*not\\b|\\s+never\\b)";
const ADVERBS = "just|already|also|actually|even|now|then|quickly";

/**
 * Every way a first-person span can open; global so matchAll walks them.
 *   modal / ability   "I can", "I could", "I will" / "I'll", "I would" /
 *                     "I'd", "I'm able", "I am going to", "I'm booking"
 *   offer             "let me" (not "let me know"), "want me to", "would
 *                     you like me to", "shall I", "should I", "happy to"
 *   completed act     "I sent", "I checked", "I've added", "I just set":
 *                     bare "I" plus an ACTION_VERB; opinion and stative
 *                     verbs ("I think", "I have a few options", "I see")
 *                     never open a span on their own
 * A negation never opens one: "I can't", "I won't", "I'm not able", "I
 * could never".
 */
const FIRST_PERSON_MARKER = new RegExp(
  [
    `\\bi\\s+(?:${MODALS})${NOT_NEGATED}\\b`,
    "\\bi'(?:ll|d)\\b(?!\\s+(?:not|never)\\b)",
    `\\bi(?:'m|\\s+am)\\s+(?!not\\b|never\\b|unable\\b)(?:able\\s+to|going\\s+to|(?:${ACTION_VERBS.join("|")})ing)\\b`,
    "\\bi(?:\\s+have|'ve)\\s+been\\s+able\\b",
    "\\blet\\s+me\\b(?!\\s+(?:know|not|never)\\b)",
    "\\b(?:want|need|like|allow|prefer|tell|ask|trust|wish)\\s+me\\s+to\\b",
    `\\b(?:${MODALS}|do\\s+you\\s+want)\\s+i\\b`,
    "\\b(?:happy|glad)\\s+to\\b",
    `\\bi(?:\\s+have|\\s+had|'ve)?(?:\\s+(?:${ADVERBS}|went\\s+ahead\\s+and))*\\s+(?:${ACTION_VERBS.join("|")})\\b`,
    `\\bwe(?:'ve|\\s+have)\\s+(?:${ACTION_VERBS.join("|")})\\b`,
    "(?:^|[.!?]\\s+)(?:done\\s*[—:-]?\\s*)?(?:booked|reserved|confirmed|scheduled|sent|emailed|ordered|purchased)\\b",
    "(?:^|[.!?]\\s+)your\\s+(?:reservation|booking|order|appointment)\\s+(?:is\\s+)?(?:booked|reserved|confirmed|scheduled)\\b",
  ].join("|"),
  "gi",
);

/**
 * A subject switch is a clause boundary, conjunction, subordinator or
 * opinion verb followed by a non-first-person subject ("if you send", ", then
 * you can book", "I'd suggest you book", "and Maya will"). In a group chat
 * "we" is the room, not Eliza, so it switches too.
 */
const SWITCH_LEADS =
  "and|but|or|so|then|if|when|whenever|unless|once|after|before|until|while|whether|that|which|what|whatever|where|who|whoever|because|since|as|though|although|" +
  "think|thought|guess|bet|hope|assume|suggest|suggested|recommend|recommended|say|said|expect|know|knew|see|saw|hear|heard|notice|noticed|mean|wish|figure|imagine|sure|glad|let|how";
const SWITCH_LEAD = `(?:[,;:(]|\\b(?:${SWITCH_LEADS})\\b)\\s*`;
const OTHER_SUBJECTS =
  "you(?:'ll|'d|'re|'ve)?|they(?:'ll|'d|'re|'ve)?|he(?:'s|'ll|'d)?|she(?:'s|'ll|'d)?|we(?:'ll|'d|'re|'ve)?|it(?:'s|'ll|'d)?|someone|somebody|anyone|anybody|everyone|everybody|nobody|no one|people";
const PRONOUN_SWITCH = new RegExp(
  `${SWITCH_LEAD}(?:${OTHER_SUBJECTS})\\b`,
  "i",
);
const SECOND_PERSON_ACTOR_SWITCH =
  /\byou(?:'ll|'d)?\s+(?:can|could|will|would|should|must|need\s+to|have\s+to|had\s+to)\b/i;
/** A capitalized name after a lead; case-sensitive so ordinary words stay. */
const NAME_SWITCH = new RegExp(`${SWITCH_LEAD}[A-Z][a-z]+\\b`);

const CHECKBOX_ITEM = /\[[ xX✓✔]\][^\n]*/g;
const QUOTED = /"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g;
const SENTENCE_BREAK = /\n+|(?<=[.!?])\s+/;

function firstSwitchIndex(rest: string): number {
  let end = rest.length;
  for (const re of [PRONOUN_SWITCH, SECOND_PERSON_ACTOR_SWITCH, NAME_SWITCH]) {
    const i = rest.search(re);
    if (i >= 0 && i < end) end = i;
  }
  return end;
}

/**
 * The first-person spans of a reply, in order of appearance. Each span is a
 * substring of one sentence, starting at its marker (so rules that key on
 * "I <verb>" still see the pronoun) and ending at the sentence end or the
 * first subject switch after the marker.
 */
export function firstPersonClaimSpans(text: string): string[] {
  const masked = text
    .replace(/[‘’]/g, "'")
    .replace(CHECKBOX_ITEM, " ")
    .replace(QUOTED, " ");
  const spans: string[] = [];
  for (const sentence of masked.split(SENTENCE_BREAK)) {
    for (const marker of sentence.matchAll(FIRST_PERSON_MARKER)) {
      const start = marker.index;
      const afterMarker = start + marker[0].length;
      const end = afterMarker + firstSwitchIndex(sentence.slice(afterMarker));
      spans.push(sentence.slice(start, end).trim());
    }
  }
  return spans;
}
