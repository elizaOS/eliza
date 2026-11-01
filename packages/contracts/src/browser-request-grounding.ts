import { parseBrowserAddressInput } from "./browser-address-input.ts";
import { IANA_TLDS } from "./iana-tlds.ts";

// The model decides whether the user wants a site opened now. This module
// decides which typed address an open may use, so a model can never open an
// address the user did not type, and which one strict command the router may
// claim without the model. It is not URL safety or SSRF authorization.

// An RFC 1123 host label: no underscore, no empty label.
const LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
// Real top-level domains mostly heard as file or app extensions ("main.py",
// "Makefile.am", "notes.one"). Such a host is a website only when the user says
// so: https://, www., the word website or site next to it, or the strict
// command below.
const FILE_TYPE_TLDS = new Set(
  "ac am app as bz cab cc cr data dot download fish fit gd gs in inc java la man map md mk ml mm mo mobi mov nc ninja one pl pm ps pt pub py rs run save sc sh so st sv tf zip".split(
    " ",
  ),
);
// One address-shaped word: https://..., www.... or a dotted host, with an
// optional port, path, query and fragment. webAddress() checks the host.
const ADDRESS =
  /^(?:https:\/\/)?[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+(?::\d+)?(?:[/?#]\S*)?$/iu;
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "“": "”",
  "‘": "’",
};
// The strict whole-message command: an optional greeting and name, then
// "(please) open|visit|go to|navigate to <address>", then an optional polite
// suffix and closing punctuation. A closed allow-list; nothing else matches.
const COMMAND =
  /^(?:(?:hey|hi|ok|okay)[,.!]?\s+)?(?:eliza[,.!]?\s+)?(?:please,?\s+)?(?:open|visit|go\s+to|navigate\s+to)\s+(\S+)(\s.*)?$/i;
const SUFFIX =
  /^\s+(?:please|for\s+me|thanks|thank\s+you|(?:would|will|could|can)\s+you)[.,!?]*$/i;
// The word website or site right before or after an address.
const SITE_BEFORE = /\b(?:web\s?)?site[:,]?\s+(?:(?:at|called|named)\s+)?$/i;
const SITE_AFTER = /^\s+(?:web\s?)?site\b/i;
// The hard negation guard, the only word list here: whether a request is for
// now is the model's call. An address is refused when a negation directly
// governs its open verb ("don't open", "do not go to", "never visit", "stop
// opening") or the address itself ("not youtube.com").
const OPEN_VERB =
  /\b(?:open(?:s|ed|ing)?|visit(?:s|ed|ing)?|go(?:es|ing)?|went|head(?:s|ed|ing)?|navigat(?:e|es|ed|ing)|tak(?:e|es|en|ing)|took|pull(?:s|ed|ing)?|bring(?:s|ing)?|brought|show(?:s|n|ed|ing)?|load(?:s|ed|ing)?|launch(?:es|ed|ing)?|brows(?:e|es|ed|ing)|access(?:es|ed|ing)?|check(?:s|ed|ing)?)\b/gi;
// Open verbs joined by "or", "and", "nor", "/" or "&", with their particles
// ("go to", "pull up"), are one group, and a negation before its first verb
// governs them all ("don't open or visit x.com"). A list comma joins only
// before such a word ("do not open, visit or load x.com"). "or" and "nor" also
// join across one object ("don't open google.com or visit x.com").
const PARTICLES = String.raw`(?:\s+(?:to|up|on|over|into|onto|out|me|us|back|at|in))*`;
const LINKED = String.raw`(?:(?:even|also|ever)\s+)?$`;
const VERB_JOIN = new RegExp(
  String.raw`^${PARTICLES}\s*(?:[/&]|,?\s+(?:or|and|nor|and/or))\s*${LINKED}`,
  "i",
);
const LIST_JOIN = new RegExp(String.raw`^${PARTICLES}\s*,\s*$`, "i");
const OBJECT_JOIN = new RegExp(
  String.raw`^${PARTICLES}\s+\S+?,?\s+(?:or|nor)\s+${LINKED}`,
  "i",
);
// A negation. Group 1 ("do not", "don't", "never") may stand alone before the
// verb ("Do not. Open. x.com"); group 2 governs only a gerund ("stop opening",
// "avoid visiting", "no going to"). "never mind open x.com" asks for x.com;
// "never mind opening x.com" does not.
const NEGATION =
  /\b(do(?:n['’]?t|['’]nt|not|[.!]?\s+not)|never(?!\s+mind\s+(?:just\s+)?(?:open|visit|go|pull|show|take|bring|load|launch|navigate|head|check|browse|access)\b))\b|\b(stop|quit|avoid|refrain\s+from|no(?=\s+[a-z]+ing\b))\b|\b(?:not|nor|cannot|no\s+need|under\s+no|at\s+no\s+(?:point|time)|by\s+no\s+means|in\s+no\s+(?:case|way|event)|on\s+no\s+account)\b|n['’]t\b|\b(?:does|did|wo|ca|should|would|could|must|is|are|was|were|have|has|had|need)nt\b/gi;
// Words a negation reaches across to its verb ("don't you dare open", "I don't
// want to go to").
const FILLER =
  "ever|even|really|just|actually|you|u|dare|yet|again|please|try|trying|to|want|wanna|need|have|gotta|go|going|gonna|bother|let|me|us";
const FILLERS = new Set(FILLER.split("|"));
// Fillers and one aside set off by commas, dashes or parentheses ("do not,
// under any circumstances, open").
const SPAN_HEAD = new RegExp(
  String.raw`^(?:[\s,]+(?:${FILLER})\b)*(?:\s*[,(\u2014\u2013]\s*[^,.!?;:()\u2014\u2013]{1,60}?\s*[,)\u2014\u2013])?(?:[\s,]+(?:${FILLER})\b)*`,
  "i",
);
// Up to four more words with no punctuation ("do not under any circumstances
// open"), or eight when they start with a preposition ("don't for any reason
// at all open"). A comma may end only a phrase that starts with a preposition
// ("don't for any reason, open"); after other words it ends the negated
// clause, so "I don't know, open x.com" is a request.
const SPAN_WORDS = /^((?:\s+[\p{L}\p{N}'’]+)+)(\s+|\s*,\s*)$/u;
const PREPOSITION =
  /^(?:under|for|at|in|on|by|with|without|from|after|before|until|during|regardless)$/i;
// The rest of the message after an address refuses it: "youtube.com, don't
// open it", "youtube.com: do not visit", "youtube.com? Never.", or a message
// that ends in a bare "don't" ("open youtube.com. Just kidding, don't").
const NEGATION_HERE = new RegExp(`^(?:${NEGATION.source})`, "i");
const TAIL_LEAD =
  /^[\s,:;.!?()"'”’\u2014\u2013-]*(?:(?:no|nope|nah|please|but|and|so|just|actually|wait|oh|hmm)[\s,.!]+)*/i;
const TAIL_END =
  /^(?:\s+(?:to|up|on|over|into|it|that|this|them|one|there|yet|now|again|please|ever|today|anymore|either|the\s+(?:link|site|website|page|url|address)))*[\s)"'”’]*(?:[.!?;,]|$)/i;
const SENTENCE_START =
  /(?:^|[.!?:])\s*(?:(?:hey|hi|ok|okay|eliza|please)[\s,.!]*)*$/i;
// The start of a question, after any greeting: "Eliza, can't you open".
const QUESTION_OPENER = String.raw`(?:^|[.!?:,])\s*(?:(?:hey|hi|ok|okay|eliza|please|so|well|then|but|and|oh|hmm)[\s,.!]*)*`;
const QUESTION_START = new RegExp(`${QUESTION_OPENER}$`, "i");
const QUESTION_START_WHY = new RegExp(
  String.raw`${QUESTION_OPENER}why\s+(?:do|does|did)?$`,
  "i",
);
const BARE_END = /(?:^|[\s.!?,;:(])(?:don['’]?t|do\s+not|never)[\s.!?)]*$/i;
// The dots a URL also reads as a label separator ("youtube。com").
const DOTS = /[\uff0e\u3002\uff61\u2024]/g;
// Host labels joined by dots, read as a URL reads an internationalized host.
const HOST_RUN =
  /[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}-]*(?:\.[\p{L}\p{N}\p{M}-]+)*/gu;
// A letter or digit joined to a host by hyphens or one dot makes it a longer
// label or host: "my-x.com", "m.x.com", "x.com-tv" and "x.com.au" are other
// hosts. "x.com-", "x.com..." and "-.x.com" are x.com.
const LABEL_BEFORE = /[a-z\d](?:-*|\.)$/;
const LABEL_AFTER = /^(?:-*|\.)[a-z\d]/;

/** The address of a strict open command that is the whole current message:
 * "(please) open|visit|go to|navigate to <address>", with an optional
 * "hey/hi/ok/okay" and "Eliza" before it and a polite suffix and closing
 * punctuation after it. Only this form may skip the model's judgment. */
export function authoredBrowserDestination(text: string): string | undefined {
  if (unreadable(text)) return;
  const command = COMMAND.exec(text.trim());
  if (!command) return;
  let target = command[1];
  if (command[2]) {
    if (!SUFFIX.test(command[2])) return;
    target = target.replace(/,$/, "");
  }
  // Quotes delimit an exact address, so nothing inside them is prose.
  const quoted = /^(["'“‘])(.+)(["'”’])[.,!?]*$/u.exec(target);
  if (quoted) {
    if (QUOTE_PAIRS[quoted[1]] !== quoted[3]) return;
    target = quoted[2];
  } else {
    // Closing punctuation after a bare host is prose. It is never removed
    // from a path, query or fragment.
    const bare = target.replace(/[.,!?]+$/, "");
    if (!/[/?#]/.test(bare.replace(/^https:\/\//i, ""))) target = bare;
  }
  return webAddress(target)?.href;
}

/** A direct client request must be a whole-message open command or a bare web address.
 * Merely mentioning a URL grounds a model proposal, but does not authorize automatic navigation. */
export function directBrowserDestination(text: string): string | undefined {
  if (unreadable(text)) return;
  const strict = authoredBrowserDestination(text);
  if (strict) return strict;
  const bare = text.trim(), url = webAddress(bare);
  if (!url) return;
  const tld = url.hostname.slice(url.hostname.lastIndexOf(".") + 1);
  if (FILE_TYPE_TLDS.has(tld) && !/^(?:https:\/\/|www\.)/i.test(bare)) return;
  return url.href;
}

/** The destination to open for a model-proposed browser URL, built from the
 * address the user typed in this message, never from the model's spelling.
 * The user must have typed a web address on the proposed host (a leading
 * "www." and letter case aside) and, when they typed a path, that path. When
 * the guard refuses any word that names the host ("don't open x.com", "don't
 * open **x.com**"), the host never opens, whatever its other words ask. */
export function groundBrowserDestination(
  userText: string,
  proposedUrl: string,
): string | undefined {
  if (unreadable(userText) || typeof proposedUrl !== "string") return;
  const parsed = parseBrowserAddressInput(proposedUrl, {
    defaultProtocol: "https:",
  });
  if (parsed.kind !== "url") return;
  const proposed = new URL(parsed.href);
  if (proposed.protocol !== "https:") return;
  const host = proposed.hostname.replace(/^www\./, "");
  const typed = typedAddresses(userText).filter(
    ({ url }) => url.hostname.replace(/^www\./, "") === host,
  );
  // "Open x.com. Actually, don't open x.com": one negated occurrence of the
  // host, on any port or path, refuses it, so a later correction is never
  // outvoted. An earlier negation also wins over a later request. A word that
  // names the host in a form no address is read from ("**x.com**",
  // "http://x.com", "x.com…") never opens it, but it refuses it.
  if (
    typed.some(({ negated }) => negated) ||
    hostWords(userText, host).some((word) => refused(userText, word))
  )
    return;
  const strict = authoredBrowserDestination(userText);
  const strictHost = strict && new URL(strict).host;
  const candidates = typed.filter(
    ({ url, webSignal }) =>
      url.port === proposed.port &&
      (webSignal ||
        url.host === strictHost ||
        !FILE_TYPE_TLDS.has(
          url.hostname.slice(url.hostname.lastIndexOf(".") + 1),
        )),
  );
  const typedPath = (url: URL) =>
    url.pathname !== "/" || url.search !== "" || url.hash !== "";
  const path = (url: URL) => url.pathname.replace(/\/$/, "") + url.search;
  return (
    candidates.find(({ url }) => url.href === proposed.href) ??
    candidates.find(
      ({ url }) => typedPath(url) && path(url) === path(proposed),
    ) ??
    candidates.find(
      ({ url }) => !typedPath(url) && url.hostname === proposed.hostname,
    ) ??
    candidates.find(({ url }) => !typedPath(url))
  )?.url.href;
}

/** Whether the message contains any web address at all, for reply copy. A
 * multiline message is never grounded, but its address was still typed. */
export function containsWebAddress(text: string): boolean {
  return (
    typeof text === "string" &&
    typedAddresses(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Read a multiline message as words.
      text.slice(0, 8192).replace(/[\u0000-\u001f\u007f]/g, " "),
    ).length > 0
  );
}

export function browserDestinationMatches(
  operation: unknown,
  destination: string | undefined,
): boolean {
  if (
    !destination ||
    !operation ||
    typeof operation !== "object" ||
    Array.isArray(operation) ||
    !("type" in operation) ||
    operation.type !== "browser_navigate" ||
    !("url" in operation) ||
    typeof operation.url !== "string"
  )
    return false;
  const parsed = parseBrowserAddressInput(operation.url, {
    defaultProtocol: "https:",
  });
  return parsed.kind === "url" && parsed.href === destination;
}

function unreadable(text: string): boolean {
  // A multiline quotation or control-delimited page excerpt is not a request.
  return (
    typeof text !== "string" ||
    text.length > 8192 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls before normalization.
    /[\u0000-\u001f\u007f]/.test(text)
  );
}

// A typed HTTPS address on a real web host: valid labels, not an IP, a number
// or a local name, and a real IANA top-level domain.
function webAddress(token: string): URL | undefined {
  if (!ADDRESS.test(token) || /["`]/.test(token)) return;
  const parsed = parseBrowserAddressInput(token, { defaultProtocol: "https:" });
  if (parsed.kind !== "url") return;
  const url = new URL(parsed.href);
  const labels = url.hostname.split(".");
  if (
    url.protocol !== "https:" ||
    url.hostname.length > 253 ||
    !labels.every((label) => LABEL.test(label)) ||
    !IANA_TLDS.has(labels[labels.length - 1])
  )
    return;
  // A bare "?" or "#" ends a sentence, not a query or fragment.
  if (!url.search) url.search = "";
  if (!url.hash) url.hash = "";
  return url;
}

// Every web address in the message, each word read with and without the
// sentence punctuation around it.
function typedAddresses(
  text: string,
): { url: URL; webSignal: boolean; negated: boolean }[] {
  const found: { url: URL; webSignal: boolean; negated: boolean }[] = [];
  for (const word of text.matchAll(/\S+/g)) {
    const lead = word[0].replace(/^[("'“‘«<\[]+/u, "");
    const tokens = new Set([
      lead,
      lead.replace(/[)\]>"'”’».,!?;:]+$/u, "").replace(/['’]s$/u, ""),
    ]);
    for (const token of tokens) {
      const url = webAddress(token);
      if (!url) continue;
      // The nearby words only: a governing verb or "website" is close by.
      const before = text.slice(Math.max(0, word.index - 500), word.index);
      const after = text.slice(word.index + word[0].length);
      found.push({
        url,
        webSignal:
          /^(?:https:\/\/|www\.)/i.test(token) ||
          SITE_BEFORE.test(before.slice(-40)) ||
          SITE_AFTER.test(after),
        negated: refused(text, word),
      });
    }
  }
  return found;
}

// Every word of the message that names the host, read as an address or not:
// "**x.com**", "http://x.com", "x.com…", "X．COM" and "www.x.com" all name
// x.com. A "www." label before the host is not part of another host.
function hostWords(text: string, host: string): RegExpExecArray[] {
  // "https://www./" names no host.
  if (!host) return [];
  const names = (form: string) => {
    for (
      let at = form.indexOf(host);
      at >= 0;
      at = form.indexOf(host, at + 1)
    ) {
      const before = form.slice(Math.max(0, at - 64), at);
      if (
        (!LABEL_BEFORE.test(before) ||
          (before.endsWith("www.") &&
            !LABEL_BEFORE.test(before.slice(0, -4)))) &&
        !LABEL_AFTER.test(form.slice(at + host.length, at + host.length + 64))
      )
        return true;
    }
    return false;
  };
  return [...text.matchAll(/\S+/g)].filter((word) => {
    const read = plain(word[0].replace(DOTS, "."));
    return (
      names(read.toLowerCase()) ||
      (/[^\p{ASCII}]/u.test(read) &&
        names(read.replace(HOST_RUN, asciiHost).toLowerCase()))
    );
  });
}

// A host as a URL reads it, so "münchen.de" names xn--mnchen-3ya.de.
function asciiHost(run: string): string {
  try {
    return new URL(`https://${run}`).hostname;
  } catch {
    return run;
  }
}

// Whether the guard refuses one word of the message: a negation governs the
// word or its open verb, the words after it refuse it, or the message ends in
// a bare "don't" or "never".
function refused(text: string, word: RegExpExecArray): boolean {
  const end = word.index + word[0].length;
  return (
    BARE_END.test(plain(text.slice(-200))) ||
    negatesOpen(text, word.index) ||
    negatedAfter(plain(text.slice(end, end + 200)))
  );
}

// True when a negation directly governs the address or the group of open
// verbs nearest before it. Refuses when unsure: a false refusal opens
// nothing, and the strict command still opens without the model.
function negatesOpen(text: string, at: number): boolean {
  const before = plain(text.slice(Math.max(0, at - 500), at));
  const targets = [before.length];
  const verbs = [...before.matchAll(OPEN_VERB)];
  let first = verbs.length - 1;
  let listed = false;
  while (first > 0) {
    const prev = verbs[first - 1];
    const between = before.slice(
      prev.index + prev[0].length,
      verbs[first].index,
    );
    if (VERB_JOIN.test(between) || OBJECT_JOIN.test(between)) listed = true;
    else if (!listed || !LIST_JOIN.test(between)) break;
    first--;
  }
  // A verb group longer than the window may hide its negation: refuse.
  if (first === 0 && verbs.length > 1 && at > 500 && verbs[0].index < 160)
    return true;
  if (first >= 0) targets.push(verbs[first].index);
  for (const negation of before.matchAll(NEGATION)) {
    const end = negation.index + negation[0].length;
    if (politeQuestion(before, negation.index, end)) continue;
    for (const target of targets) {
      if (target < end || target - end > 160) continue;
      const span = before.slice(end, target);
      // "Do not. Open. x.com" only where the negation starts a sentence:
      // "No, don't. Open x.com" asks for x.com.
      const standalone =
        Boolean(negation[1]) &&
        SENTENCE_START.test(
          before.slice(Math.max(0, negation.index - 40), negation.index),
        );
      if (governs(span, standalone)) {
        // "stop", "quit", "avoid" and "refrain from" negate an -ing verb only.
        if (!negation[2] || /ing\b/i.test(before.slice(end, target + 12)))
          return true;
      }
    }
  }
  return false;
}

// The words after an address refuse it: a negated open verb with only "it",
// "that" or a like word after it, or a bare "don't" or "never".
function negatedAfter(after: string): boolean {
  const tail = after.slice(TAIL_LEAD.exec(after)?.[0].length ?? 0);
  const negation = NEGATION_HERE.exec(tail);
  if (!negation) return false;
  const rest = tail.slice(negation[0].length);
  if (negation[1] && /^[\s)]*(?:[.!?;]|$)/.test(rest)) return true;
  const verb = new RegExp(OPEN_VERB.source, "i").exec(rest);
  return (
    !!verb &&
    governs(rest.slice(0, verb.index), false) &&
    (!negation[2] ||
      /ing\b/i.test(rest.slice(0, verb.index + verb[0].length))) &&
    TAIL_END.test(rest.slice(verb.index + verb[0].length))
  );
}

// One spelling of apostrophes, letters and ellipses. Emphasis marks and emoji
// read as spaces, and invisible characters are dropped.
function plain(text: string): string {
  return text
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[‘ʼ´`]/g, "'")
    .normalize("NFKC")
    .replace(
      /[*_~[\]{}<>|^]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\ufe0f|\u20e3/gu,
      " ",
    );
}

// "why don't you open", "why not open", "can't you open" and "won't you open"
// at the start of a sentence ask for an open; they do not forbid one.
function politeQuestion(text: string, start: number, end: number): boolean {
  const lead = text.slice(Math.max(0, start - 60), start);
  if (QUESTION_START_WHY.test(lead)) return true;
  const word = /[\p{L}'’]+$/u.exec(text.slice(0, end));
  return (
    !!word &&
    /^(?:ca|could|wo|would|should)n['’]?t$/i.test(word[0]) &&
    /^\s+(?:you|u)\b/i.test(text.slice(end)) &&
    QUESTION_START.test(text.slice(Math.max(0, word.index - 60), word.index))
  );
}

// Whether the text between a negation and its verb or address keeps them in
// one clause.
function governs(text: string, standalone: boolean): boolean {
  // "Do not. Open." and "Don't! Ever! Open": a stop after a sentence-initial
  // "do not", "don't" or "never" reads as a comma.
  const span = standalone ? text.replace(/[.!]+/g, ",") : text;
  const rest = span.slice(SPAN_HEAD.exec(span)?.[0].length ?? 0);
  if (/^(?:[\s,\u2014\u2013"'“”’-]|\.{2,})*$/.test(rest)) return true;
  const phrase = SPAN_WORDS.exec(rest);
  if (!phrase) return false;
  const words = phrase[1].trim().split(/\s+/);
  return (
    (!phrase[2].includes(",") || PREPOSITION.test(words[0])) &&
    !words.some((word) => /^(?:and|but|then|so)$/i.test(word)) &&
    words.filter((word) => !FILLERS.has(word.toLowerCase())).length <=
      (PREPOSITION.test(words[0]) ? 8 : 4) &&
    // "don't forget to open" asks for the open.
    !/^(?:forget|forgot|hesitate|fail|neglect)\s+to\b/i.test(words.join(" "))
  );
}
