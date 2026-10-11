/**
 * Parse Cookie header values from fetch Request / raw header strings.
 * Used by Hono routes and shared lib auth (no framework cookie helpers).
 */
export function getCookieValueFromHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  for (const segment of header.split(";")) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    if (segment.slice(0, eq).trim() !== name) continue;
    const raw = segment.slice(eq + 1).trim();
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // error-policy:J3 untrusted-input sanitizing — a cookie value with
      // `%` / `%2` / `%ZZ` throws URIError. Malformed encoding is an
      // absent cookie, not a request crash on auth/admission paths.
      return undefined;
    }
    // Fail closed on ambiguity, matching parseCookieHeader in
    // packages/app/src/api/auth/sessions.ts: a name that appears more
    // than once with differing values (e.g. a sibling-subdomain cookie
    // shadowing ours), or with an empty value, is an absent cookie, so
    // an auth/admission caller never acts on an attacker-chosen copy.
    // Identical copies (host-only and domain variants of one credential)
    // are unambiguous and still read as that value.
    if (decoded.length === 0) return undefined;
    if (found !== undefined && found !== decoded) return undefined;
    found = decoded;
  }
  return found;
}

export function getCookieValueFromRequest(request: Request, name: string): string | undefined {
  return getCookieValueFromHeader(request.headers.get("cookie"), name);
}
