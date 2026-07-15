import { describe, expect, it } from "bun:test";
import { ElizaError, redactLogArgs } from "@elizaos/core";
import { describeUnhandledError } from "./unhandled-error-detail";

/**
 * Regression coverage for the #16145 diagnosability gap: the
 * `[CloudApi] Unhandled error` log used to pass the raw Error through the
 * log-sink redactor, which rebuilds Error instances with NON-enumerable
 * message/stack — so Cloudflare's JSON tail rendered every unhandled 500 as
 * `{"error":{"name":"ElizaError"}}` with no message, code, or cause. The
 * staging KMS misconfig hid behind exactly that line.
 */

function kmsGuardError(): ElizaError {
  // Mirrors the real staging throw (kms-client.ts KMS_MEMORY_BACKEND_FORBIDDEN).
  return new ElizaError(
    "Refusing to start with the ephemeral 'memory' KMS backend outside test/development",
    {
      code: "KMS_MEMORY_BACKEND_FORBIDDEN",
      severity: "fatal",
      context: { backend: "memory", environment: "staging", nodeEnv: "production" },
    },
  );
}

describe("the failure mode this module exists for", () => {
  it("raw Error through redactLogArgs JSON-serializes to name-only (the #16145 tail)", () => {
    const [redacted] = redactLogArgs([kmsGuardError()]);
    // The redactor's `instanceof Error` branch rebuilds via `new Error(...)`,
    // so classification fields are gone and message/stack are non-enumerable.
    const tailView = JSON.parse(JSON.stringify(redacted));
    expect(tailView).toEqual({ name: "ElizaError" });
  });
});

describe("describeUnhandledError", () => {
  it("preserves message, code, severity, and context through JSON serialization", () => {
    const detail = describeUnhandledError(kmsGuardError());
    const tailView = JSON.parse(JSON.stringify(detail));
    expect(tailView.name).toBe("ElizaError");
    expect(tailView.message).toContain("memory");
    expect(tailView.code).toBe("KMS_MEMORY_BACKEND_FORBIDDEN");
    expect(tailView.severity).toBe("fatal");
    expect(tailView.context).toEqual({
      backend: "memory",
      environment: "staging",
      nodeEnv: "production",
    });
  });

  it("survives the log-sink redactor as a plain object (what the logger actually emits)", () => {
    const [redacted] = redactLogArgs([{ error: describeUnhandledError(kmsGuardError()) }]);
    const tailView = JSON.parse(JSON.stringify(redacted)) as {
      error: Record<string, unknown>;
    };
    expect(tailView.error.code).toBe("KMS_MEMORY_BACKEND_FORBIDDEN");
    expect(tailView.error.message).toContain("KMS backend");
  });

  it("still masks sensitive context keys via the redaction sink", () => {
    const err = new ElizaError("boom", {
      code: "X",
      context: { apiKey: "eliza_super_secret_value", table: "api_keys" },
    });
    const [redacted] = redactLogArgs([{ error: describeUnhandledError(err) }]);
    const tailView = JSON.parse(JSON.stringify(redacted)) as {
      error: { context: Record<string, unknown> };
    };
    expect(tailView.error.context.apiKey).not.toContain("super_secret");
    expect(tailView.error.context.table).toBe("api_keys");
  });

  it("summarizes one level of Error cause with name/message/code", () => {
    const pgError = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const wrapped = new ElizaError("db unavailable", { code: "DB_DOWN", cause: pgError });
    const detail = describeUnhandledError(wrapped);
    expect(detail.cause).toEqual({
      name: "Error",
      message: "connection refused",
      code: "ECONNREFUSED",
    });
  });

  it("captures pg SQLSTATE codes from plain driver errors", () => {
    const pg = Object.assign(new Error("failed query: insert into ..."), { code: "23505" });
    const detail = describeUnhandledError(pg);
    expect(detail.code).toBe("23505");
    expect(detail.name).toBe("Error");
  });

  it("captures KmsError-style numeric status", () => {
    const kms = Object.assign(new Error("steward 404"), { status: 404 });
    expect(describeUnhandledError(kms).status).toBe(404);
  });

  it("never throws on non-Error values", () => {
    expect(describeUnhandledError("boom")).toEqual({ value: "boom" });
    expect(describeUnhandledError(undefined)).toEqual({ value: "undefined" });
    expect(describeUnhandledError({ odd: true })).toEqual({ value: "[object Object]" });
  });

  it("never throws even for unstringifiable throws (global error boundary contract)", () => {
    // Null-prototype object: String(value) throws TypeError (no toString).
    const nullProto = Object.create(null) as Record<string, never>;
    expect(describeUnhandledError(nullProto)).toEqual({ value: "[object Object]" });

    // Hostile toString AND hostile Symbol.toPrimitive.
    const hostile = {
      toString() {
        throw new Error("nope");
      },
      [Symbol.toPrimitive]() {
        throw new Error("nope");
      },
    };
    expect(describeUnhandledError(hostile)).toEqual({ value: "[object Object]" });

    // Hostile cause on a real Error must not break the summary either.
    const wrapped = new ElizaError("outer", { code: "X", cause: nullProto });
    expect((describeUnhandledError(wrapped) as { cause: string }).cause).toBe("[object Object]");
  });
});
