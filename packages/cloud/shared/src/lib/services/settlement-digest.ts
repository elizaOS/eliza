/** Produces canonical replay digests for immutable billing settlement contracts. */
import { createHash } from "node:crypto";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      // Code-unit order, not localeCompare: ICU collation is locale-dependent and
      // ranks canonically equivalent distinct keys as equal, so the replay digest
      // would vary with the host locale and with key insertion order.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
}

export function canonicalSettlementJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

export function settlementDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSettlementJson(value)).digest("hex");
}
