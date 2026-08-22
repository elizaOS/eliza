/** Classifies phone-domain failures without copying untrusted error text into logs. */

export const POSTGRES_UNDEFINED_TABLE_CODE = "42P01";
export const PHONE_SCHEMA_MIGRATION_REQUIRED_CODE = "PHONE_SCHEMA_MIGRATION_REQUIRED";
export const PHONE_MESSAGE_PERSISTENCE_FAILED_CODE = "PHONE_MESSAGE_PERSISTENCE_FAILED";
export const PHONE_MESSAGE_ROUTING_UNAVAILABLE_CODE = "PHONE_MESSAGE_ROUTING_UNAVAILABLE";

export type PhoneErrorClass =
  | "bridge_failed"
  | "gateway_metadata_invalid"
  | "object_storage_failed"
  | "payload_invalid"
  | "payload_persistence_failed"
  | "payload_pointer_invalid"
  | "payload_unavailable"
  | "postgres_undefined_table"
  | "routing_lookup_failed"
  | "schema_migration_required"
  | "unexpected_phone_failure";

const ERROR_CLASS_BY_CODE: ReadonlyMap<string, PhoneErrorClass> = new Map([
  [POSTGRES_UNDEFINED_TABLE_CODE, "postgres_undefined_table"],
  [PHONE_SCHEMA_MIGRATION_REQUIRED_CODE, "schema_migration_required"],
  [PHONE_MESSAGE_PERSISTENCE_FAILED_CODE, "payload_persistence_failed"],
  [PHONE_MESSAGE_ROUTING_UNAVAILABLE_CODE, "routing_lookup_failed"],
  ["PHONE_GATEWAY_METADATA_INVALID", "gateway_metadata_invalid"],
  ["PHONE_MESSAGE_METADATA_INVALID", "payload_invalid"],
  ["PHONE_MESSAGE_MEDIA_URLS_INVALID", "payload_invalid"],
  ["PHONE_STORED_JSON_INVALID", "payload_invalid"],
  ["PHONE_MIGRATION_JSON_INVALID", "payload_invalid"],
  ["DATABASE_MIGRATION_JSON_INVALID", "payload_invalid"],
  ["PHONE_MIGRATION_TIMESTAMP_INVALID", "payload_invalid"],
  ["PHONE_MESSAGE_POINTER_INVALID", "payload_pointer_invalid"],
  ["PHONE_MESSAGE_PAYLOAD_UNAVAILABLE", "payload_unavailable"],
  ["OBJECT_STORAGE_FIELD_POINTER_INVALID", "payload_pointer_invalid"],
  ["OBJECT_STORAGE_FIELD_UNAVAILABLE", "object_storage_failed"],
  ["OBJECT_STORAGE_FIELD_JSON_INVALID", "object_storage_failed"],
]);

function readErrorProperty(error: object, property: "cause" | "code"): unknown {
  try {
    return (error as { cause?: unknown; code?: unknown })[property];
  } catch {
    // error-policy:J3 hostile error accessors are treated as absent diagnostics.
    return undefined;
  }
}

function visitErrorChain(error: unknown, visitor: (code: string) => boolean): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16; depth += 1) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      seen.has(current)
    ) {
      return false;
    }
    seen.add(current);
    const code = readErrorProperty(current, "code");
    if (typeof code === "string" && visitor(code)) return true;
    current = readErrorProperty(current, "cause");
  }
  return false;
}

/** Match only an exact stable error code, including through bounded causes. */
export function phoneErrorHasCode(error: unknown, expectedCode: string): boolean {
  return visitErrorChain(error, (code) => code === expectedCode);
}

export function isPostgresUndefinedTableError(error: unknown): boolean {
  return phoneErrorHasCode(error, POSTGRES_UNDEFINED_TABLE_CODE);
}

export function isPhoneSchemaMigrationRequired(error: unknown): boolean {
  return phoneErrorHasCode(error, PHONE_SCHEMA_MIGRATION_REQUIRED_CODE);
}

/** True only for a canonical phone-message write that did not commit. */
export function isPhoneMessagePersistenceFailure(error: unknown): boolean {
  return phoneErrorHasCode(error, PHONE_MESSAGE_PERSISTENCE_FAILED_CODE);
}

/** True only when the canonical phone routing lookup could not be completed. */
export function isPhoneMessageRoutingUnavailable(error: unknown): boolean {
  return phoneErrorHasCode(error, PHONE_MESSAGE_ROUTING_UNAVAILABLE_CODE);
}

/** Return an allowlisted class; Error.name/message/cause text is never emitted. */
export function phoneErrorDiagnostic(error: unknown): {
  errorClass: PhoneErrorClass;
} {
  let errorClass: PhoneErrorClass = "unexpected_phone_failure";
  visitErrorChain(error, (code) => {
    const classified = ERROR_CLASS_BY_CODE.get(code);
    if (!classified) return false;
    errorClass = classified;
    return true;
  });
  return { errorClass };
}
