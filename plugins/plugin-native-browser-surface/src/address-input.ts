export type BrowserAddressInput =
  | { kind: "url"; href: string }
  | { kind: "search"; query: string }
  | {
      kind: "rejected";
      reason:
        | "empty"
        | "invalid-input"
        | "invalid-url"
        | "credentials"
        | "unsupported-protocol";
    };

/** Local address-bar classification, not navigation authorization or an SSRF check.
 * Hosts own aliases, search providers, HTTPS upgrades and user-facing errors.
 */
export function parseBrowserAddressInput(
  input: string,
  options: { defaultProtocol: "http:" | "https:" },
): BrowserAddressInput {
  const value = input.trim();
  if (!value) return { kind: "rejected", reason: "empty" };
  // Reject ambiguous separators before URL normalization can erase them.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls before WHATWG URL normalization.
  if (/[\u0000-\u001f\u007f\\]/.test(value))
    return { kind: "rejected", reason: "invalid-input" };
  // A host with a numeric port is a URL, not a scheme — including
  // single-label hosts (localhost:3000, nas:8080). Requiring a dot in
  // the host let those fall into the scheme test below, where the host
  // name was misread as a protocol and the input was rejected.
  // Bracketed IPv6 literals ([::1]:8080) are the same shape: without the
  // bracket form they fall through to the search fallback even though the
  // user typed a complete address. The port is optional — a bare literal
  // ([::1]) is a complete loopback address, not a search query.
  const hostPort =
    /^[^\s/:]+:\d+(?:[/?#]|$)/.test(value) ||
    /^\[[0-9a-fA-F:.%]+\](?::\d+)?(?:[/?#]|$)/.test(value);
  const explicit = !hostPort && /^[a-z][a-z\d+.-]*:/i.test(value);
  const domain = /^[^\s/?#]+\.[^\s/?#]+(?:[/?#].*)?$/.test(value);
  if (!explicit && !domain && !hostPort && !value.startsWith("//")) {
    if (value.includes("@")) return { kind: "rejected", reason: "credentials" };
    return { kind: "search", query: value };
  }
  let url: URL;
  try {
    url = new URL(
      value.startsWith("//")
        ? `${options.defaultProtocol}${value}`
        : explicit
          ? value
          : `${options.defaultProtocol}//${value}`,
    );
  } catch {
    return { kind: "rejected", reason: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { kind: "rejected", reason: "unsupported-protocol" };
  if (url.username || url.password)
    return { kind: "rejected", reason: "credentials" };
  return { kind: "url", href: url.href };
}
