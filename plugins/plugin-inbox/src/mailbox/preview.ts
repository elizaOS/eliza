/**
 * Gmail snippets contain HTML character references but are displayed as text.
 * Only individual references are parsed, never the provider's markup, and the
 * text is decoded once. The reference decoder defaults to the DOM's own entity
 * table when a document is available.
 */
let decoder: HTMLTextAreaElement | undefined;
/**
 * Marketing preheaders pad snippets with long runs of invisible characters.
 * Individual language joiners and ordinary non-breaking spaces are preserved.
 */
// biome-ignore lint/suspicious/noMisleadingCharacterClass: each invisible code unit is matched on its own, never as a grapheme.
const PADDING_RUN = /[ \u00a0\u00ad\u034f\u200b-\u200f\u2060\u2800\ufeff]{3,}/g;

function domReference(reference: string): string {
  if (typeof document === "undefined") return numericReference(reference);
  decoder ??= document.createElement("textarea");
  decoder.innerHTML = reference;
  return decoder.value;
}

/** Numeric references and the five XML entities; everything else is kept as written. */
export function numericReference(reference: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": "\u00a0",
  };
  const lower = reference.toLowerCase();
  if (lower in named) return named[lower] as string;
  const numeric = /^&#(x[0-9a-f]{1,6}|[0-9]{1,7});$/i.exec(reference);
  if (!numeric) return reference;
  const body = numeric[1] as string;
  const code =
    body[0] === "x" || body[0] === "X"
      ? Number.parseInt(body.slice(1), 16)
      : Number.parseInt(body, 10);
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    ? String.fromCodePoint(code)
    : "\ufffd";
}

export function decodeMailPreview(
  text: string,
  decodeReference: (reference: string) => string = domReference,
): string {
  const decoded = text.includes("&")
    ? text.replace(
        /&(?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi,
        decodeReference,
      )
    : text;
  return decoded.replace(PADDING_RUN, " ").trim();
}
