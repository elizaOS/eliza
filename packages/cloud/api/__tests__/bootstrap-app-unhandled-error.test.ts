/**
 * bootstrap-app onError — unhandled errors log a diagnosable plain-object
 * summary (#16145), not a raw Error the log-sink redactor strips to `{name}`.
 *
 * Builds the REAL app via `createApp()` (real middleware chain, real generated
 * router, real onError handler) and drives it in-process with `app.request`.
 * A throwing route is mounted under the public `/api/public` prefix so the
 * request reaches the handler without a session. The logger's console sink is
 * observed (not replaced-under-test): we assert the structured
 * `[CloudApi] Unhandled error` line carries message/code/cause after passing
 * the real redaction pipeline.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import { createApp } from "../src/bootstrap-app";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

function captureConsoleError(): unknown[][] {
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return calls;
}

describe("createApp onError (unhandled-error logging)", () => {
  test("an unhandled throw logs a plain-object summary with message, code, and cause", async () => {
    const app = createApp();

    // Real route through the real chain — public prefix bypasses the session
    // gate so the throw originates inside a handler, exactly like a live 500.
    app.get("/api/public/__coverage-throw", () => {
      const cause = new Error("kms unreachable");
      const err = new Error("Failed to create wallet") as Error & {
        code?: string;
        cause?: unknown;
      };
      err.code = "kms_unavailable";
      err.cause = cause;
      throw err;
    });

    const calls = captureConsoleError();
    // Empty bindings object stands in for the Worker `env` (in-process
    // `app.request` has no wrangler runtime); the public path needs none.
    const res = await app.request(
      "http://localhost/api/public/__coverage-throw",
      {},
      {},
    );
    console.error = originalConsoleError;

    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);

    const unhandled = calls.find(
      (args) => args[0] === "[CloudApi] Unhandled error",
    );
    expect(unhandled).toBeDefined();
    const context = unhandled?.[1] as {
      error: {
        name: string;
        message: string;
        code?: string;
        cause?: { message?: string };
      };
    };
    // The whole point of the change: enumerable diagnostics survive, so a
    // JSON log tail shows the failure in one line instead of `{name}` only.
    expect(context.error.name).toBe("Error");
    expect(context.error.message).toBe("Failed to create wallet");
    expect(context.error.code).toBe("kms_unavailable");
    expect(
      typeof context.error.cause === "string"
        ? context.error.cause
        : context.error.cause?.message,
    ).toContain("kms unreachable");
    // Plain object, not an Error instance — Error instances lose
    // message/stack to non-enumerability in the JSON tail.
    expect(context.error).not.toBeInstanceOf(Error);
    expect(Object.keys(context.error)).toContain("message");
  });

  test("an ApiError below 500 takes the quiet debug branch, not the unhandled log", async () => {
    const app = createApp();
    app.get("/api/public/__coverage-api-error", () => {
      throw new ApiError(404, "resource_not_found", "nope");
    });

    const calls = captureConsoleError();
    const res = await app.request(
      "http://localhost/api/public/__coverage-api-error",
      {},
      {},
    );
    console.error = originalConsoleError;

    expect(res.status).toBe(404);
    expect(
      calls.find((args) => args[0] === "[CloudApi] Unhandled error"),
    ).toBeUndefined();
  });
});
