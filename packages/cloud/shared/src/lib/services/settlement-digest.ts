/** Produces canonical replay digests for immutable billing settlement contracts. */
import { createHash } from "node:crypto";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
}

export function canonicalSettlementJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

export function settlementDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSettlementJson(value)).digest("hex");
}
