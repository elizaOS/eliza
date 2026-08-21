/** Lossless JSON number hydration for PostgreSQL JSONB and object storage. */

import Decimal from "decimal.js";

type RawJsonApi = typeof JSON & {
  isRawJSON?: (value: unknown) => boolean;
  rawJSON?: (source: string) => unknown;
};

type JsonParseContext = { source?: string };

const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function rawJsonApi(): RawJsonApi {
  return JSON as RawJsonApi;
}

/** True only for a standards-backed raw JSON number, never an arbitrary lookalike object. */
export function isPhoneLosslessJsonNumber(value: unknown): boolean {
  const api = rawJsonApi();
  if (typeof api.isRawJSON !== "function" || !api.isRawJSON(value)) return false;
  const source = (value as { rawJSON?: unknown }).rawJSON;
  return typeof source === "string" && JSON_NUMBER_PATTERN.test(source);
}

function numberRoundTripsExactly(source: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return false;
  try {
    return new Decimal(source).equals(new Decimal(serialized));
  } catch {
    return false;
  }
}

/**
 * Parse JSON while retaining numbers that cannot round-trip through a JS
 * `number` as `JSON.rawJSON` values. They remain exact when the hydrated
 * payload crosses a JSON response/storage boundary instead of becoming
 * `Infinity`, zero, or a rounded integer.
 */
export function parsePhoneJsonLosslessly(raw: string): unknown {
  const api = rawJsonApi();
  return JSON.parse(raw, (_key: string, value: unknown, context?: JsonParseContext) => {
    if (typeof value !== "number") return value;
    const source = context?.source;
    if (!source) {
      throw new TypeError("Runtime cannot inspect the source of a JSON number");
    }
    if (numberRoundTripsExactly(source, value)) return value;
    if (typeof api.rawJSON !== "function") {
      throw new TypeError("Runtime cannot preserve an out-of-range JSON number");
    }
    return api.rawJSON(source);
  });
}

/**
 * Parse a persisted phone JSON object without ever allowing the JSON driver to
 * coerce numeric leaves first. The error deliberately contains no source text:
 * persisted metadata can include credentials and provider payload details.
 */
export function parsePhoneLosslessJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parsePhoneJsonLosslessly(raw);
  } catch {
    throw new TypeError("Persisted phone metadata is not valid lossless JSON");
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isPhoneLosslessJsonNumber(value)
  ) {
    throw new TypeError("Persisted phone metadata is not a JSON object");
  }
  return value as Record<string, unknown>;
}
