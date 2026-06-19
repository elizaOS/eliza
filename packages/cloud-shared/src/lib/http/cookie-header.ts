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
    return decodeURIComponent(trimmed.slice(name.length + 1).trimStart());
  }
  return undefined;
}

export function getCookieValueFromRequest(request: Request, name: string): string | undefined {
  return getCookieValueFromHeader(request.headers.get("cookie"), name);
}
