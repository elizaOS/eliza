/** Distinguish omitted boolean query parameters from invalid values. */
import { parseBooleanValue } from "@elizaos/core";
export function parseOptionalBooleanQuery(
  raw: string | null,
): { ok: true; value?: boolean } | { ok: false } {
  if (raw === null) return { ok: true };
  const value = parseBooleanValue(raw);
  return value === undefined ? { ok: false } : { ok: true, value };
}
