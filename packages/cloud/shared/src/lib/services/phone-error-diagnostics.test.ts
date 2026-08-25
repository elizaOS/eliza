/** Exercises bounded phone-error classification with hostile deterministic errors. */

import { describe, expect, test } from "bun:test";
import {
  isPhoneMessagePersistenceFailure,
  isPhoneMessageRoutingUnavailable,
  isPhoneSchemaMigrationRequired,
  isPostgresUndefinedTableError,
  phoneErrorDiagnostic,
} from "./phone-error-diagnostics";

describe("phone error diagnostics", () => {
  test("never copies arbitrary name, message, code, or cause text", () => {
    const sentinel = "SENTINEL_PRIVATE_PROVIDER_BODY";
    const nested = Object.assign(new Error(`${sentinel}-cause-message`), {
      name: `${sentinel}-cause-name`,
      code: `${sentinel}-cause-code`,
    });
    const error = Object.assign(new Error(`${sentinel}-message`, { cause: nested }), {
      name: `${sentinel}-name`,
      code: `${sentinel}-code`,
    });

    const serialized = JSON.stringify(phoneErrorDiagnostic(error));
    expect(serialized).toBe('{"errorClass":"unexpected_phone_failure"}');
    expect(serialized).not.toContain(sentinel);
    expect(isPhoneSchemaMigrationRequired(error)).toBe(false);
    expect(isPhoneMessagePersistenceFailure(error)).toBe(false);
    expect(isPhoneMessageRoutingUnavailable(error)).toBe(false);
    expect(isPostgresUndefinedTableError(error)).toBe(false);
  });

  test("recognizes the canonical message persistence retry signal through causes", () => {
    const persistenceError = Object.assign(new Error("not logged"), {
      code: "PHONE_MESSAGE_PERSISTENCE_FAILED",
      cause: Object.assign(new Error("also not logged"), {
        code: "OBJECT_STORAGE_UPLOAD_FAILED",
      }),
    });

    expect(isPhoneMessagePersistenceFailure(persistenceError)).toBe(true);
    expect(phoneErrorDiagnostic(persistenceError)).toEqual({
      errorClass: "payload_persistence_failed",
    });
  });

  test("recognizes an unavailable routing lookup as retryable through causes", () => {
    const routingError = Object.assign(new Error("not logged"), {
      code: "PHONE_MESSAGE_ROUTING_UNAVAILABLE",
      cause: new Error("SENTINEL_DATABASE_BODY"),
    });

    expect(isPhoneMessageRoutingUnavailable(routingError)).toBe(true);
    expect(phoneErrorDiagnostic(routingError)).toEqual({
      errorClass: "routing_lookup_failed",
    });
    expect(JSON.stringify(phoneErrorDiagnostic(routingError))).not.toContain(
      "SENTINEL_DATABASE_BODY",
    );
  });

  test("recognizes only stable allowlisted codes through bounded causes", () => {
    const schemaError = Object.assign(new Error("not logged"), {
      code: "PHONE_SCHEMA_MIGRATION_REQUIRED",
      cause: Object.assign(new Error("also not logged"), { code: "42P01" }),
    });

    expect(phoneErrorDiagnostic(schemaError)).toEqual({
      errorClass: "schema_migration_required",
    });
    expect(isPhoneSchemaMigrationRequired(schemaError)).toBe(true);
    expect(isPostgresUndefinedTableError(schemaError)).toBe(true);
  });

  test("terminates safely on cyclic and hostile cause accessors", () => {
    const cyclic: { code: string; cause?: unknown } = { code: "untrusted" };
    cyclic.cause = cyclic;
    const hostile = Object.defineProperty({}, "code", {
      get() {
        throw new Error("SENTINEL_GETTER_BODY");
      },
    });

    expect(phoneErrorDiagnostic(cyclic)).toEqual({
      errorClass: "unexpected_phone_failure",
    });
    expect(phoneErrorDiagnostic(hostile)).toEqual({
      errorClass: "unexpected_phone_failure",
    });
  });
});
