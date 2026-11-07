/**
 * Shared phrase-refusal scope for typed phone workflow generation. Hosts run it before any
 * /api/workflow/phone/generate request so requests the typed phone catalog can
 * never satisfy (calls, SMS, payments, Contacts, arbitrary code, email to
 * unnamed recipients) are refused on the phone and never sent to the model.
 * This is a refusal filter only. The typed catalog is the hard bound: anything
 * the filter lets through is still limited by the agent's typed catalog, compiler
 * validation and separate review/Save/Run, so a missed phrasing can never add a
 * capability. It recognizes phrasings, not intent: wording it does not recognize
 * reaches the generator, which still cannot emit a step outside the typed catalog.
 * Patterns are therefore kept narrow enough not to refuse supported requests that
 * merely share a word with an unsupported one ("ring the changes", "call me out",
 * "whether to book a room", "notes on the website redesign").
 */
export type WorkflowScopeCategory =
  | "calls"
  | "sms"
  | "payments"
  | "contacts"
  | "code"
  | "email";
export type WorkflowScopeResult =
  | { refused: false }
  | { refused: true; categories: WorkflowScopeCategory[]; message: string };

/** Reviewable names for the typed operations a phone workflow can use. */
export const WORKFLOW_OPERATION_LABELS: Readonly<Record<string, string>> = {
  supplied_text: "Read supplied text",
  selected_notes: "Read selected Notes",
  selected_reminders: "Read today’s reminders",
  calendar_range: "Read a Calendar range",
  contains: "Continue if text matches",
  compose_draft: "Compose text",
  model_draft: "Ask the agent to draft text",
  save_note: "Save a note",
  app_notification: "Post a notification",
  read_aloud: "Read aloud",
};

const reasons: Record<WorkflowScopeCategory, string> = {
  calls: "place or answer phone calls",
  sms: "send text messages",
  payments: "make payments or move money",
  contacts: "read or change Contacts",
  code: "run arbitrary code, scripts or web requests",
  email: "send email to recipients you have not named",
};

// A verb at the start of a clause ("call Maya", "…, then text Sam"), never a noun such as "call notes" or "supplied text".
// "to" opens an instruction ("a workflow to call Maya") but not a question the workflow answers
// ("when I am free to call the bank", "which bills to pay first").
const asked = String.raw`(?<!\b(?:[Ww]hether|[Ww]hen|[Ww]here|[Hh]ow|[Ww]hat|[Ww]hich|[Ww]ho|[Ww]hom)\s+(?:[\w'’-]+\s+){0,3})`;
// Polite wrappers open a clause too ("could you kindly pay my rent", "I'd like you to call Maya").
// Loanword courtesies count ("bitte call Maya", "por favor call Maya", "plz text Sam").
const polite = String.raw`[Kk]indly|[Jj]ust|[Nn]ow|[Yy]ou|[Ll]et['’]?s|[Gg]o|[Bb]itte|[Ff]avou?r|[Pp]lait|[Pp]lz|[Pp]ls`;
const clause =
  String.raw`(?:^|[.,;:!?]\s*|\b(?:[Aa]nd|[Tt]hen|[Pp]lease|[Aa]lso|[Oo]r)\s+|` +
  asked +
  String.raw`\b(?:[Tt]o|` +
  polite +
  String.raw`)\s+)`;
const target = String.raw`(?:me\b|him\b|her\b|them\b|us\b|back\b|[Mm]y\s+\w+|[Mm]om\b|[Dd]ad\b|[A-Z][\w'-]*|\+?\d)`;
const verb = (words: string) =>
  new RegExp(clause + "(?:" + words + ")\\s+" + target);
// An imperative at the start of a clause in any letter case ("call maya", "CALL MAYA", "text the group"),
// unless the next word makes it a noun phrase ("call notes", "text from the note") or a naming ("call it Morning").
const anyClause = clause;
const nounTail = String.raw`(?:notes?|logs?|sheets?|summar(?:y|ies)|histor(?:y|ies)|transcripts?|lists?|recordings?|agendas?|digests?|prep|it|this|that|these|those|from|in|on|of|for|is|was|are|were|should|must|will|can|and|or|to|with|about|files?|messages?|texts?|contents?|body|fields?|titles?|sizes?|only|if|when|then|notifications?|steps?|out|off|down|attention)\b`;
// A naming of the workflow or its output ("call the workflow Morning brief"), not a phone call.
const naming = String.raw`the\s+(?:workflow|note|draft|digest|summary|notification|result|output)\b`;
const interface_ = String.raw`(?:an?|the|my|this|that)\s+(?:\w+\s+)?(?:api|endpoint|webhook|function|script|url|command|program)\b`;
const imperative = (words: string) =>
  new RegExp(
    anyClause +
      "(?:" +
      words +
      ")\\s+(?!" +
      nounTail +
      ")(?!" +
      interface_ +
      ")(?!" +
      naming +
      ")[\\p{L}\\d+]",
    "iu",
  );
// A determiner target ("the dentist", "a taxi") for verbs that are too often nouns to match broadly.
// Idioms are not calls ("ring the changes", "that rings a bell").
const determined = (words: string) =>
  new RegExp(
    anyClause +
      "(?:" +
      words +
      ")\\s+(?!(?:the|an?)\\s+(?:changes|bell|alarm|doorbell|till|curtain)\\b)(?:the|an?|our|his|her|their|your|every(?:one|body)|some(?:one|body))\\s+\\p{L}",
    "iu",
  );
const callPatterns = [
  /\b(?:make|place|start|schedule|return)\s+(?:a\s+|the\s+)?(?:phone\s+|voice\s+|video\s+)?calls?\b/i,
  /\b(?:answer|pick\s+up|decline|reject)\s+(?:the\s+|my\s+|incoming\s+)*calls?\b/i,
  /\b(?:when(?:ever)?|if)\s+\S+\s+calls\b/i,
  verb("[Cc]all|[Pp]hone|[Dd]ial|[Rr]ing|[Tt]elephone"),
  imperative("call|dial|facetime|telephone|(?:voice|video)[\\s-]+call"),
  determined("phone|telephone|ring(?:\\s+up)?"),
  // Periphrastic calls: "give Maya a call", "get Sam on the phone", "hop on a call with Sam".
  /\bgive\s+(?:[\p{L}'’-]+\s+){1,3}a\s+(?:call|ring|bell)\b(?![-\w])/iu,
  /\bget\s+(?:[\p{L}'’-]+\s+){1,3}on\s+the\s+(?:phone|line)\b/iu,
  /\b(?:hop|jump|get)\s+on\s+(?:a|the)\s+(?:\w+\s+)?call\s+with\b/i,
];
const smsPatterns = [
  /\b(?:sms|mms|imessage|whatsapp|telegram|text\s+messages?|signal\s+messages?)\b/i,
  // "shoot Sam a text", "drop Maya a text", "send Sam a DM", never "a text summary".
  /\b(?:shoot|drop|fire\s+off|send)\s+(?:[\p{L}'’-]+\s+){0,3}(?:a|an)\s+(?:quick\s+)?(?:text|txt|dm|direct\s+message)\b(?!\s+(?:summar|version|draft|file|note|digest|outline|overview|recap|field|block|snippet|description))/iu,
  /\b(?:know|tell|notify|alert|reach|update)\s+(?:[\p{L}'’-]+\s+){0,2}(?:by|via|over)\s+(?:text|txt)\b/iu,
  /\bsend\s+(?:a\s+|an\s+)?(?:quick\s+)?(?:message|text)\b/i,
  /\b(?:when(?:ever)?|if)\s+\S+\s+(?:texts|messages)\b/i,
  verb("[Tt]e?xt|[Mm]essage|DM|[Rr]eply\\s+to"),
  imperative("te?xt|message"),
];
// A purchase stated as an instruction ("buy milk", "then purchase the tickets"), never "what to buy".
const instruction = String.raw`(?:^|[.,;:!?]\s*|\b(?:and|then|please|also|or|kindly|just|now)\s+)`;
const paymentPatterns = [
  /\b(?:make|send|schedule|process|submit|initiate|authori[sz]e|approve)\s+(?:a\s+|the\s+|my\s+|any\s+)?(?:\w+\s+)?payments?\b/i,
  new RegExp(
    clause +
      "(?:[Pp]ay|[Vv]enmo|[Zz]elle|[Pp]ay[Pp]al|[Rr]efund|[Rr]eimburse)\\s+(?!attention\\b)",
  ),
  verb("[Ww]ire"),
  /(?<!\b(?:whether|when|how|what|which|should|could)\s+(?:I\s+|we\s+)?(?:to\s+)?)\bsettle\s+(?:up|(?:my|the|our)\s+(?:\w+\s+){0,2}(?:bills?|invoices?|tab|debts?|balance))\b/i,
  /\b(?:top[\s-]?up|cash\s+out|check\s*out\s+(?:my|the|our)\s+(?:cart|basket|order))\b/i,
  /(?<!\b(?:whether|when|how|what|which|should|could)\s+(?:I\s+|we\s+)?(?:to\s+)?)\b(?:renew|start|upgrade|buy|purchase)\s+(?:my|the|our|an?)\s+(?:\w+\s+){0,2}(?:subscription|membership)\b/i,
  // An order placed for someone ("order me a pizza", "order some food"), never "order them by date".
  new RegExp(
    instruction +
      String.raw`order\s+(?:(?:me|us)\s+(?:an?|some|the)|(?:an?|some)\s+(?!list\b|summary\b|digest\b|draft\b|notes?\b))\s*\p{L}`,
    "iu",
  ),
  /\b(?:with|via|through|using|on|in|use)\s+(?:my\s+)?(?:venmo|paypal|zelle|cash\s*app|apple\s+pay|google\s+pay)\b/i,
  /\b(?:wire|bank)\s+transfer\b/i,
  /\b(?:charge|bill|debit)\s+(?:my\s+|the\s+|a\s+)?(?:credit\s+card|debit\s+card|bank\s+account|card|account)\b/i,
  /\b(?:buy|sell|trade|swap|send)\s+(?:some\s+|my\s+|\d[\d.,]*\s+)?(?:bitcoin|btc|eth(?:ereum)?|crypto(?:currency)?|stocks?|shares)\b/i,
  new RegExp(instruction + "(?:buy|purchase|donate)\\s+\\S", "i"),
  /\b(?:with|using)\s+(?:my|our)\s+(?:credit\s+|debit\s+)?card\b/i,
  /\bplace\s+(?:an?|the|my)\s+order\b/i,
  /\bsubscribe\s+to\b/i,
  // A booking stated as an instruction ("book a flight", "a workflow to book a taxi"), never a question
  // the workflow answers ("tell me if I should book a room", "whether to book a table").
  new RegExp(
    String.raw`(?<!\b(?:whether|when|where|how|what|which|who)\s+)` +
      anyClause +
      String.raw`book\s+(?:an?|the|my|our)\s+(?:\w+\s+)?(?:flight|hotel|table|tickets?|ride|room|car|taxi|cab)\b`,
    "i",
  ),
  /\b(?:tip|donate)\b[^.!?\n]{0,30}(?:\$|€|£|\d+\s*(?:dollars|euros|pounds))/i,
  new RegExp(instruction + "tip\\s+(?:the|my|our)\\s+\\p{L}", "iu"),
  /\b(?:send|transfer|move|withdraw|deposit|wire|lend)\s+(?:[\p{L}'’-]+\s+){0,2}?(?:money\b|funds\b|cash\b|\$|€|£|(?:\d[\d.,]*|a\s+hundred|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s*(?:dollars|bucks|euros|pounds|quid)\b)/iu,
  /\b(?:to|in|into|from)\s+(?:my\s+)?wallet\b/i,
];
// The Contacts app or address book as a data source or target, never "my contact at Acme".
const contactPatterns = [
  /\bContacts\b/,
  /\b(?:my|the|all|our|your|phone)\s+contacts\b/i,
  /\bcontact\s+(?:list|card|details|info(?:rmation)?)\b/i,
  /\baddress[\s-]*book\b/i,
  /\bphone[\s-]*book\b/i,
  /\b(?:add|save|store)\s+(?:[\p{L}'’-]+\s+){1,2}as\s+an?\s+(?:new\s+)?contact\b/iu,
  /\b(?:add|create|save|update|delete|remove|edit|import|export|sync)\s+(?:(?:a|an|the|new|my|these|those)\s+)*contacts?\b(?!\s+lens)/i,
];
const codePatterns = [
  /\b(?:run|execute|exec|eval|evaluate|use|write|create|add|call|invoke)\s+(?:a\s+|an\s+|this\s+|my\s+|some\s+|the\s+)?(?:following\s+)?(?:custom\s+)?(?:(?:python|javascript|typescript|node|bash|ruby|perl|lua|sql|shell|lambda|cloud|serverless)\s+)?(?:code|script|shell|command|program|python|javascript|js|bash|sql|query|snippet|function)\b(?!\s+(?:summar(?:y|ies)|overview|outline|review|notes?|description|explanation|list|section|title|name|heading|recap|digest|reference|glossary|comment|ideas?)\b)/i,
  /\b(?:run|execute)\s+(?:a\s+|an\s+|this\s+|some\s+|the\s+)?(?:shell|terminal|bash|powershell)\b/i,
  /\b(?:curl|wget|sudo|webhook|http\s+(?:request|call|post|get)|api\s+(?:call|request)|fetch\s+(?:the\s+)?url)\b/i,
  /```|<script\b|\beval\s*\(|\bfunction\s*\(|=>\s*\{/i,
  /\b(?:run|execute|exec)\s+(?:rm|ls|cat|npm|npx|pip|git|python3?|node|sh|bash|zsh|powershell|cmd|chmod|ssh)\b/i,
  /\b(?:open|start|launch|spawn|use|spin\s+up)\s+(?:a\s+|the\s+|my\s+)?(?:shell|terminal|command\s+line|console)\b/i,
  /\b(?:run|execute|exec)\s+`|\bcron\b/i,
  /\b(?:call|hit|query|use|invoke|ping)\s+(?:an?\s+|the\s+|my\s+|this\s+|that\s+)?(?:\w+\s+)?(?:api|endpoint|webhook)\b/i,
  // A literal address near a retrieval verb, or the web resource as that verb's own object ("load the
  // website", "open the company web page"). Not a later mention ("load my notes and summarise the
  // website redesign section") and not a topic ("open my notes on the website copy").
  /\b(?:fetch|download|scrape|crawl|request|load|visit|open|get|pull|post\s+to)\b[^.!?\n]{0,40}(?:https?:\/\/|\bwww\.)/i,
  // A bare domain as the thing retrieved ("scrape example.com", "download the file at example.com/report.pdf").
  /\b(?:fetch|download|scrape|crawl|request|load|visit|pull)\s+(?:[\w-]+\s+){0,4}?[\w-]+\.(?:com|org|net|io|dev|app|ai|co|gov|edu|info)\b/i,
  /\b(?:fetch|download|scrape|crawl|request|load|visit|open|get|post\s+to)\s+(?:(?:from|to|at)\s+)?(?:(?:an?|the|this|that|my|our|its|their)\s+)?(?:(?!(?:and|then|or|on|about|for|of|in|with)\b)[\w-]+\s+){0,2}(?:urls?|websites?|web\s*pages?|web\s*sites?|endpoints?)\b(?!\s+(?:redesign|design|notes?|copy|drafts?|plan|project|section|content|ideas?|launch|feedback|review|brief|update|text|team|migration|shortener|list|summary)\b)/i,
];
const emailSend = [
  /\b(?:send|forward|reply|cc|bcc)\b[^.!?\n]{0,60}\b(?:e-?mails?|mail)\b/i,
  new RegExp(
    anyClause +
      "(?:mail|forward)\\s+(?:it|this|that|these|those|them|the|my|our|a|an|all|every)\\b",
    "i",
  ),
  /\be-?mail\s+(?!me\b|myself\b)(?:it|this|that|these|them|him|her|everyone|everybody|someone|somebody|people|the\s+\w+|a\s+\w+|an\s+\w+|my\s+\w+|our\s+\w+|all\b|to\b)/i,
];
// "shoot the team an email", "drop my boss an email".
emailSend.push(
  /\b(?:shoot|drop|fire\s+off)\s+(?:[\p{L}'’-]+\s+){1,3}an\s+e-?mail\b/iu,
);
const explicitAddress = /[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/i;
const ownerOnly =
  /\b(?:to\s+me|to\s+myself|e-?mail\s+me|e-?mail\s+myself|send\s+me|mail\s+me|me\s+an?\s+e-?mail)\b/i;

// Subjects of supported steps ("notes about bill payments", "remind me to call Mom", "a notification
// saying text Sam") describe what a note, reminder or notification says. They are not actions, so
// that span is ignored up to the next clause boundary.
const subject =
  /\b(?:remind(?:er)?\s+(?:me\s+)?(?:to|about)|(?:a|the)\s+(?:note|notification|reminder)\s+(?:to|about|saying|that\s+says)|notes?\s+(?:about|on|mentioning|containing|that\s+mention|mentions?)|notify\s+me\s+(?:to|about)|(?:titled|called|named|labell?ed))\s+[^.;:!?\n,]*?(?=[.;:!?\n,]|\s+(?:and\s+)?then\b|$)/gi;
// Invisible characters that would split a recognized word without changing how the request reads.
const invisible = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
// Letters of other scripts that read as Latin ones ("call" typed with a Cyrillic a). Folded for recognition only.
const lookalikes: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ɡ: "g",
  ӏ: "l",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  У: "Y",
  Х: "X",
  І: "I",
  Ј: "J",
  Ѕ: "S",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};
// Compatibility forms, accents, invisible splits, lookalike letters and typographic hyphens all read as the plain word.
const plain = (prompt: string) =>
  prompt
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(invisible, "")
    .replace(/[\u0370-\u052F\u0261]/g, (letter) => lookalikes[letter] ?? letter)
    .replace(/[\u2010-\u2015]/g, "-");

// Phrases that share a verb with a refused action and mean something a workflow can do: a change of
// wording ("ring the changes"), pointing something out ("call me out on overdue items") and an app
// notification ("message me a notification"). Only these exact shapes are set aside; "call me",
// "text me a notification" and "message Sam a notification" are still refused.
const benign =
  /\bring\s+the\s+changes\b|\bcall\s+(?:me|him|her|them|us|it)\s+out\b(?!\s+of\b)|\bmessage\s+me\s+(?:with\s+)?(?:an?|the|my)\s+(?:\w+\s+)?notifications?\b/gi;

/** Categories the typed phone catalog cannot satisfy, in a stable order. */
export function workflowScopeCategories(
  prompt: string,
): WorkflowScopeCategory[] {
  const text = plain(prompt).replace(benign, " note ").replace(subject, " ");
  const found: WorkflowScopeCategory[] = [];
  if (callPatterns.some((p) => p.test(text))) found.push("calls");
  if (smsPatterns.some((p) => p.test(text))) found.push("sms");
  if (paymentPatterns.some((p) => p.test(text))) found.push("payments");
  if (contactPatterns.some((p) => p.test(text))) found.push("contacts");
  if (codePatterns.some((p) => p.test(text))) found.push("code");
  if (
    emailSend.some((p) => p.test(text)) &&
    !explicitAddress.test(text) &&
    !ownerOnly.test(text)
  )
    found.push("email");
  return found;
}

function list(items: string[]) {
  return items.length <= 1
    ? items.join("")
    : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

/** Refuses before generation and names the operations this agent and phone can use instead. */
export function checkWorkflowScope(
  prompt: string,
  operations: readonly string[],
): WorkflowScopeResult {
  const categories = workflowScopeCategories(prompt);
  if (!categories.length) return { refused: false };
  const available = operations
    .map((id) => WORKFLOW_OPERATION_LABELS[id])
    .filter((label): label is string => !!label);
  const offer = available.length
    ? ` Workflows here can use: ${available.join("; ")}.`
    : " No typed workflow steps are available on this agent right now.";
  return {
    refused: true,
    categories,
    message: `Workflows can’t ${list(categories.map((c) => reasons[c]))}. Nothing was sent to the agent.${offer} Rephrase the request using these steps.`,
  };
}
