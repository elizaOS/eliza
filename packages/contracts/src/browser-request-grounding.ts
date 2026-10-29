import { parseBrowserAddressInput } from "./browser-address-input.ts";

/** A destination explicitly authored in a whole current request. This is not
 * URL safety/SSRF authorization, page-content authority, or a site-name resolver. */
export function authoredBrowserDestination(text: string): string | undefined {
  if (text.length > 8192) return;
  // A multiline quotation or control-delimited page excerpt is not a command.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls before normalization.
  if (/[\u0000-\u001f\u007f]/.test(text)) return;
  const value = text.trim();
  const command =
    /^(?:please\s+)?(?:open|visit|go\s+to|navigate\s+to)\s+(.+?)(?:\s+please)?$/i.exec(
      value,
    );
  let target = command ? command[1] : value;
  // Quotes are only authority when they delimit the target of an explicit command.
  if (
    command &&
    ((target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'")))
  )
    target = target.slice(1, -1);
  else {
    if (/^["'`]/.test(target) || /["`]/.test(target)) return;
    // Sentence punctuation on an unquoted host-only command is prose. Never
    // remove punctuation from a path, query, fragment or explicitly quoted URL.
    if (
      command &&
      /^(?:https:\/\/)?(?:[a-z\d-]+\.)+[a-z\d-]+[.!]$/i.test(target)
    )
      target = target.slice(0, -1);
  }
  if (!target || /\s/.test(target)) return;
  const parsed = parseBrowserAddressInput(target, {
    defaultProtocol: "https:",
  });
  if (parsed.kind !== "url") return;
  const url = new URL(parsed.href);
  if (url.protocol !== "https:") return;
  // The address bar also accepts searches and permissive host spelling. An
  // action request must name an actual complete host, not an email or alias.
  if (
    url.hostname.includes("..") ||
    url.hostname.startsWith(".") ||
    (!url.hostname.includes(".") &&
      url.hostname !== "localhost" &&
      !url.hostname.startsWith("["))
  )
    return;
  return parsed.href;
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
