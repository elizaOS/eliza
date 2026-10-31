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
  "am app cab cc cr data dot download fish gs in inc java la md mk ml mm mo mobi mov nc one pl pm ps pt pub py rs run sh so st tf zip".split(
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
// An open verb, and a negation that directly governs it ("don't open", "do not
// go to", "never visit", "stop opening", "do not, under any circumstances,
// open"). This is the only word list: whether a request is for now is the
// model's call.
const OPEN_VERB =
  /\b(?:open(?:s|ed|ing)?|visit(?:s|ed|ing)?|go(?:es|ing)?|went|head(?:s|ed|ing)?|navigat(?:e|es|ed|ing)|tak(?:e|es|en|ing)|took|pull(?:s|ed|ing)?|bring(?:s|ing)?|brought|show(?:s|n|ed|ing)?|load(?:s|ed|ing)?|launch(?:es|ed|ing)?|brows(?:e|es|ed|ing)|access(?:es|ed|ing)?|check(?:s|ed|ing)?)\b/gi;
const NEGATED =
  /(?:\b(?:not|never|cannot|stop|quit|no\s+need)|n['’]t|\b(?:do|does|did|wo|ca|should|would|could|must|is|are|was|were|have|has|had|need)nt)(?:,[^,.!?;]{1,60},)?(?:,?\s+(?:ever|even|really|just|actually|you|u|dare|yet|again|please|try|trying|to|want|wanna|need|have|gotta|go|going|gonna|bother|let|me|us))*,?\s+$/i;

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

/** The destination to open for a model-proposed browser URL, built from the
 * address the user typed in this message, never from the model's spelling.
 * The user must have typed a web address on the proposed host (a leading
 * "www." and letter case aside) and, when they typed a path, that path. An
 * address whose open verb is negated ("don't open x.com") never qualifies. */
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
  const strict = authoredBrowserDestination(userText);
  const strictHost = strict && new URL(strict).host;
  const candidates = typedAddresses(userText).filter(
    ({ url, webSignal, negated }) =>
      !negated &&
      url.port === proposed.port &&
      url.hostname.replace(/^www\./, "") ===
        proposed.hostname.replace(/^www\./, "") &&
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

/** Whether the message contains any web address at all, for reply copy. */
export function containsWebAddress(text: string): boolean {
  return !unreadable(text) && typedAddresses(text).length > 0;
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
        negated: negatesOpen(before),
      });
    }
  }
  return found;
}

// True when the open verb nearest before an address, in its sentence, is
// directly negated.
function negatesOpen(before: string): boolean {
  const sentence = before.split(/[.!?;]\s/).pop() ?? "";
  let verb = -1;
  for (const match of sentence.matchAll(OPEN_VERB)) verb = match.index;
  return (
    verb >= 0 && NEGATED.test(sentence.slice(Math.max(0, verb - 200), verb))
  );
}
