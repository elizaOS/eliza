/**
 * Parse Cookie header values from fetch Request / raw header strings.
 * Used by Hono routes and shared lib auth (no framework cookie helpers).
 */
export function getCookieValueFromHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  const segments = header.split(";");
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const raw = trimmed.slice(name.length + 1).trimStart();
    try {
      return decodeURIComponent(raw);
    } catch {
      // error-policy:J3 untrusted-input sanitizing — a cookie value with
      // `%` / `%2` / `%ZZ` throws URIError. Malformed encoding is an
      // absent cookie, not a request crash on auth/admission paths.
      return undefined;
    }
  }
  return undefined;
}

export function getCookieValueFromRequest(request: Request, name: string): string | undefined {
  return getCookieValueFromHeader(request.headers.get("cookie"), name);
}
