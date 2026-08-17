/**
 * Decodes one URL path component without binding validation to an HTTP server.
 * Callers translate malformed encoding at their transport boundary and apply
 * domain-specific grammar checks to the decoded value.
 */

export type PathComponentDecodeResult =
  | { ok: true; value: string }
  | { ok: false; reason: "malformed-encoding" };

export function decodeUrlPathComponent(raw: string): PathComponentDecodeResult {
  try {
    return { ok: true, value: decodeURIComponent(raw) };
  } catch {
    // error-policy:J3 malformed percent escapes are explicit invalid input.
    return { ok: false, reason: "malformed-encoding" };
  }
}
