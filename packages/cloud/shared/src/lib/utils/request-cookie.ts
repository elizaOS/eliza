/** Cookie parsing for standard Fetch `Request` (Workers; no `Request#cookies`). */
export function getRequestCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        // error-policy:J3 untrusted cookie values — a malformed percent-escape
        // is an absent cookie, not a worker fault.
        return null;
      }
    }
  }
  return null;
}
