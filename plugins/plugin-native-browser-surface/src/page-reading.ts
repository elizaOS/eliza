/**
 * Renderer half of page reading (read aloud, ask about a page): the same
 * conservative credential heuristic as `BrowserPageReading` (Android) for
 * pasted, edited or web-build text; the provider capability probe; and the
 * page-question excerpt rule, including the fallback when the provider has
 * no isolated world. The heuristic cannot establish that arbitrary content is
 * credential-free; ambiguous text fails closed.
 */

/** Native reject codes; a renderer never parses message text. */
export const READING_UNSUPPORTED = "reading-unsupported";
export const ISOLATED_WORLD_UNAVAILABLE = "isolated-world-unavailable";
export const SENSITIVE_PAGE = "sensitive-page";
/** The longest excerpt a native review releases. */
export const MAX_READING_EXCERPT = 5000;

/** Engineering default wording; the native side says the same (`UNSUPPORTED_MESSAGE`). */
export const READING_UNSUPPORTED_MESSAGE =
  "Read aloud and Ask about page are unavailable on this device: its Android System WebView cannot read a page privately. Update Android System WebView.";
export const SENSITIVE_READING_MESSAGE =
  "This page may contain credentials or verification codes. Open a different page.";

/**
 * Credential words. Sign-in, log-in and vault stand alone, so "designing",
 * "blog in" and "dialog-inner" read as prose; `_` and digits still separate
 * them ("login_form", "btn-login2"). `BrowserPageReading.EXTRACT` holds the
 * same pattern, which the test checks.
 */
export const sensitiveReadingPattern =
  /(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|password|passphrase|passcode|credential|(?<![a-z])vaults?(?![a-z])|one[\s-]*time[\s-]*(?:password|code)|verification[\s-]*code|security[\s-]*code|authentication[\s-]*code|recovery[\s-]*(?:code|key|phrase)|backup[\s-]*(?:code|key)|seed[\s-]*phrase|secret[\s-]*key|private[\s-]*key|authenticator|two[\s-]*factor|multi[\s-]*factor|(?<![a-z])sign[\s-]*in(?![a-z])|(?<![a-z])log[\s-]*in(?![a-z])|\botp\b|\bmfa\b|\b2fa\b)/i;
/** camelCase as separate words, so `signInButton` reads as "sign In Button". */
export const readingWords = (value: string) =>
  value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
const sensitive = (value: string) =>
  sensitiveReadingPattern.test(value) ||
  sensitiveReadingPattern.test(readingWords(value));
const passwordServices = [
  "pass.proton.me",
  "account.proton.me",
  "accounts.google.com",
  "passwords.google.com",
  "bitwarden.com",
  "bitwarden.eu",
  "1password.com",
  "lastpass.com",
  "dashlane.com",
  "keepersecurity.com",
  "nordpass.com",
  "passbolt.com",
];
const sensitiveRoute =
  /(?:^|[^a-z0-9])(?:api[\s_-]*key|vault|passwords?|passphrase|signin|sign-in|login|log-in|logout|auth|oauth|sso|account|accounts|security|mfa|2fa|otp|recovery|reset-password|credentials?|access_token|id_token|refresh_token|secret|token)(?:$|[^a-z0-9])/;
const normalize = (value: string) =>
  value.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "");

/** Credential prose or an unlabelled six-to-eight digit code. */
export function sensitiveReadingText(text: string): boolean {
  const value = normalize(text);
  return sensitive(value) || /(?:^|\D)\d{6,8}(?:\D|$)/.test(value);
}

/**
 * An address that must not be read: not http(s), user info, a password
 * service, or a decoded route that names sign-in, account, recovery, token or
 * similar material. Anything unparseable is sensitive.
 */
export function sensitiveReadingUrl(address: string): boolean {
  try {
    if (address.length > 8192) return true;
    const url = new URL(address);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return true;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      passwordServices.some(
        (service) => host === service || host.endsWith(`.${service}`),
      )
    )
      return true;
    return sensitiveRoute.test(
      decodeURIComponent(address.replace(/\+/g, " ")).toLowerCase(),
    );
  } catch {
    return true;
  }
}

/** A password, one-time-code or similar credential input, by its type, autocomplete or label. */
const credentialField =
  /(?:^|[^a-z0-9])(?:otp|totp|mfa|2fa)(?:$|[^a-z0-9])|password|passcode|one[\s_-]*time|verification[\s_-]*code|security[\s_-]*code|auth(?:entication)?[\s_-]*code/i;
const SKIPPED = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"];
/** Page chrome and links: their sign-in wording is not page content. */
const CHROME = ["NAV", "HEADER", "FOOTER", "A"];

/**
 * The same scan as the native extraction, for a parsed document: the whole
 * document is searched for credential inputs (password, one-time-code and
 * similar fields); credential prose, unlabelled short codes and the size
 * budget apply only to the selected article (`article`, `main`,
 * `[role="main"]`, else `body`), without nav, header, footer or links.
 */
export function sensitiveReadingDocument(root: Node): boolean {
  const pending: Node[] = [root];
  let inspected = 0;
  let article: Node | undefined;
  let body: Node | undefined;
  while (pending.length) {
    if (++inspected > 12000) return true;
    const node = pending.pop() as Node;
    // A document or fragment root is walked into; text has no children.
    if (node.nodeType === 1) {
      const element = node as Element;
      const tag = element.tagName.toUpperCase();
      if (SKIPPED.includes(tag)) continue;
      if (tag === "INPUT") {
        const type = (element.getAttribute("type") || "").toLowerCase();
        const labels = [
          "autocomplete",
          "id",
          "name",
          "aria-label",
          "placeholder",
        ]
          .map((attr) => normalize(element.getAttribute(attr) || ""))
          .join(" ");
        if (type === "password" || credentialField.test(labels)) return true;
      }
      if (
        !article &&
        (tag === "ARTICLE" ||
          tag === "MAIN" ||
          element.getAttribute("role") === "main")
      )
        article = node;
      if (!body && tag === "BODY") body = node;
    }
    if (node.childNodes.length + pending.length > 12000) return true;
    for (let i = node.childNodes.length - 1; i >= 0; i--)
      pending.push(node.childNodes[i]);
  }
  pending.push(article ?? body ?? root);
  let characters = 0;
  let text = "";
  while (pending.length) {
    const node = pending.pop() as Node;
    if (node.nodeType === 1) {
      const element = node as Element;
      const tag = element.tagName.toUpperCase();
      if (
        SKIPPED.includes(tag) ||
        CHROME.includes(tag) ||
        element.getAttribute("role") === "navigation"
      )
        continue;
      for (const attr of [
        "type",
        "autocomplete",
        "id",
        "name",
        "class",
        "aria-label",
        "title",
        "placeholder",
      ]) {
        const value = element.getAttribute(attr) || "";
        characters += value.length;
        if (
          value.length > 1024 ||
          characters > 65536 ||
          sensitive(normalize(value))
        )
          return true;
      }
    } else if (node.nodeType === 3) {
      const value = node.nodeValue || "";
      characters += value.length;
      if (value.length > 20000 || characters > 65536) return true;
      text += ` ${normalize(value)}`;
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--)
      pending.push(node.childNodes[i]);
  }
  return sensitiveReadingText(text);
}

export type ReadingSupport = "unknown" | "available" | "unavailable";

export interface ReadingSupportProbe {
  /** Last confirmed answer; "unknown" until the native side has answered. */
  readonly state: ReadingSupport;
  /** Asks once and remembers a definite answer; a failed question is asked again next time. */
  check(): Promise<ReadingSupport>;
}

/**
 * `query` asks the native browser whether this provider can read a page in an
 * isolated world. Only an explicit boolean is believed: a failed or malformed
 * answer leaves the state unknown, and the native review then refuses on its
 * own if it must. `changed` runs when a definite answer first arrives.
 */
export function createReadingSupport(
  query: () => Promise<unknown>,
  changed: () => void = () => {},
): ReadingSupportProbe {
  let state: ReadingSupport = "unknown";
  let pending: Promise<ReadingSupport> | undefined;
  return {
    get state() {
      return state;
    },
    check() {
      if (state !== "unknown") return Promise.resolve(state);
      pending ??= Promise.resolve()
        .then(query)
        .then(
          (answer): ReadingSupport => {
            const available = (
              answer as { available?: unknown } | null | undefined
            )?.available;
            if (available === true) state = "available";
            else if (available === false) state = "unavailable";
            if (state !== "unknown") changed();
            return state;
          },
          (): ReadingSupport => state,
        )
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}

/** A released page-question excerpt and whether the page was cut to fit it. */
export interface PageQuestionReading {
  text: string;
  /** True when the provider stopped before the end of the page. */
  truncated: boolean;
}

/**
 * The excerpt a native page-question review released, for the host's own
 * question review, with whether the page was cut to fit the excerpt so the
 * review can say so. When the provider cannot read the page in an isolated
 * world the text is "" and the host's review opens empty for pasted text; a
 * sensitive page, or a released excerpt that reads as sensitive, is refused
 * with `SENSITIVE_PAGE` and never opens a review. Other failures are rethrown.
 */
export async function pageQuestionReading(
  review: () => Promise<unknown>,
): Promise<PageQuestionReading> {
  let result: unknown;
  try {
    result = await review();
  } catch (error) {
    const { code, message } = (error ?? {}) as {
      code?: unknown;
      message?: unknown;
    };
    if (code === SENSITIVE_PAGE) throw error;
    // Native builds before the reject codes said so only in their message.
    if (
      code === ISOLATED_WORLD_UNAVAILABLE ||
      /^Isolated page reading is unavailable/.test(String(message ?? ""))
    )
      return { text: "", truncated: false };
    throw error;
  }
  const { text, truncated } = (result ?? {}) as {
    text?: unknown;
    truncated?: unknown;
  };
  const excerpt = typeof text === "string" ? text : "";
  if (excerpt && sensitiveReadingText(excerpt))
    throw Object.assign(new Error(SENSITIVE_READING_MESSAGE), {
      code: SENSITIVE_PAGE,
    });
  if (!excerpt.trim() || excerpt.length > MAX_READING_EXCERPT)
    return { text: "", truncated: false };
  return { text: excerpt, truncated: truncated === true };
}

/**
 * The text of {@link pageQuestionReading}, for hosts that do not show whether
 * the page was cut.
 */
export async function pageQuestionExcerpt(
  review: () => Promise<unknown>,
): Promise<string> {
  return (await pageQuestionReading(review)).text;
}
