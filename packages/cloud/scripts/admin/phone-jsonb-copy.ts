/** Lossless helpers for copying legacy phone JSON fields into PostgreSQL JSONB. */

import { ElizaError } from "@elizaos/core";

export type PhoneJsonShape = "object" | "string_array";

const PHONE_JSON_RULES: Readonly<
  Record<
    string,
    Readonly<
      Record<string, Readonly<{ shape: PhoneJsonShape; nullable: boolean }>>
    >
  >
> = {
  agent_phone_numbers: { metadata: { shape: "object", nullable: true } },
  phone_message_log: {
    media_urls: { shape: "string_array", nullable: true },
    metadata: { shape: "object", nullable: true },
  },
  agent_phone_contacts: { metadata: { shape: "object", nullable: false } },
  phone_gateway_devices: { metadata: { shape: "object", nullable: false } },
};

export interface RawJsonParameter {
  readonly kind: "raw-json-parameter";
  /** Exact source JSON lexeme passed to PostgreSQL as a bound parameter. */
  readonly raw: string;
  /** Parsed only for top-level/shape validation; never serialized for the copy. */
  readonly parsed: unknown;
}

/** Runtime brand that cannot collide with JSON values read from PostgreSQL. */
const rawJsonParameters = new WeakSet<object>();

export function phoneJsonShape(
  table: string,
  column: string,
): PhoneJsonShape | null {
  return PHONE_JSON_RULES[table]?.[column]?.shape ?? null;
}

export function phoneJsonAllowsNull(
  table: string,
  column: string,
): boolean | null {
  return PHONE_JSON_RULES[table]?.[column]?.nullable ?? null;
}

export function isRawJsonParameter(value: unknown): value is RawJsonParameter {
  return (
    typeof value === "object" &&
    value !== null &&
    rawJsonParameters.has(value) &&
    (value as { kind?: unknown }).kind === "raw-json-parameter" &&
    typeof (value as { raw?: unknown }).raw === "string"
  );
}

/** Validate syntax while retaining every original numeric and whitespace lexeme. */
export function prepareRawPhoneJson(input: {
  table: string;
  column: string;
  value: unknown;
}): RawJsonParameter | null {
  if (input.value === null || input.value === undefined) {
    if (phoneJsonAllowsNull(input.table, input.column) === false) {
      throw new ElizaError("Required phone JSON is null", {
        code: "PHONE_MIGRATION_JSON_INVALID",
        context: {
          table: input.table,
          column: input.column,
          rule: "not_null",
        },
      });
    }
    return null;
  }
  if (typeof input.value !== "string") {
    throw new ElizaError("Phone JSON copy requires raw source text", {
      code: "PHONE_MIGRATION_JSON_INVALID",
      context: {
        table: input.table,
        column: input.column,
        rule: "raw_json_text",
      },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.value) as unknown;
  } catch (cause) {
    // error-policy:J3 malformed legacy data aborts the batch before any write.
    throw new ElizaError("Malformed legacy phone JSON", {
      code: "PHONE_MIGRATION_JSON_INVALID",
      context: { table: input.table, column: input.column, rule: "valid_json" },
      cause,
    });
  }
  if (parsed === null) {
    throw new ElizaError("Phone JSON cannot contain the JSON null value", {
      code: "PHONE_MIGRATION_JSON_INVALID",
      context: {
        table: input.table,
        column: input.column,
        rule: "json_null",
      },
    });
  }
  const parameter: RawJsonParameter = {
    kind: "raw-json-parameter",
    raw: input.value,
    parsed,
  };
  rawJsonParameters.add(parameter);
  return parameter;
}

export function rawJsonParameterValue(value: RawJsonParameter): string {
  return value.raw;
}

/** Check only the JSON token shape; numeric lexemes remain authoritative raw text. */
export function rawJsonHasObjectTopLevel(value: RawJsonParameter): boolean {
  return (
    typeof value.parsed === "object" &&
    value.parsed !== null &&
    !Array.isArray(value.parsed)
  );
}

export function jsonbParameterPlaceholder(index: number): string {
  return `$${index}::jsonb`;
}

export function parsedJsonValidationValue(value: unknown): unknown {
  return isRawJsonParameter(value) ? value.parsed : value;
}

/** PostgreSQL OID 1114 is timezone-less; Cloud persists and reads it as UTC. */
export function parsePgTimestampWithoutTimezoneUtc(value: string): Date {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(`${normalized}Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ElizaError("Invalid PostgreSQL timestamp without timezone", {
      code: "PHONE_MIGRATION_TIMESTAMP_INVALID",
      context: { oid: 1114, rule: "utc_timestamp" },
    });
  }
  return parsed;
}
