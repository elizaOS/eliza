/**
 * Parses iMessage contact identifiers shared by both HTTP route adapters.
 */

export type ParsedContactId =
  | { ok: true; id: string }
  | { ok: false; reason: "missing" | "malformed" };

export function parseIMessageContactId(pathname: string): ParsedContactId {
  const prefix = "/api/imessage/contacts/";
  if (!pathname.startsWith(prefix)) return { ok: false, reason: "missing" };
  const rest = pathname.slice(prefix.length);
  if (!rest) return { ok: false, reason: "missing" };
  try {
    const id = decodeURIComponent(rest);
    return id ? { ok: true, id } : { ok: false, reason: "missing" };
  } catch {
    // error-policy:J3 Contact identifiers are untrusted path input. Preserve
    // the distinction between an absent identifier and malformed encoding.
    return { ok: false, reason: "malformed" };
  }
}
