/**
 * Exercises both shared diagnostic entry points with ordinary, serialized,
 * cross-realm-like, and deliberately hostile unknown values.
 */
import { describe, expect, it } from "vitest";
import {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "./error-classification.ts";
import { formatErrorWithStack } from "./format-error.ts";

const formatters = [formatErrorWithStack, formatUncaughtError] as const;

describe.each(formatters)("safe diagnostic formatter", (formatDiagnostic) => {
  it("prefers a nonblank stack, then a message", () => {
    expect(formatDiagnostic({ stack: "stack trace", message: "message" })).toBe(
      "stack trace",
    );
    expect(formatDiagnostic({ stack: "   ", message: "message" })).toBe(
      "message",
    );
  });

  it("preserves primitive and nullish diagnostics", () => {
    expect(formatDiagnostic("failure")).toBe("failure");
    expect(formatDiagnostic(null)).toBe("null");
    expect(formatDiagnostic(undefined)).toBe("undefined");
  });

  it("does not throw for poisoned getters, proxies, or coercion", () => {
    const poisonedGetter = {
      get stack(): string {
        throw new Error("poisoned stack getter");
      },
      message: "preserved message",
    };
    const hostileProxy = new Proxy(
      {},
      {
        get(): never {
          throw new Error("poisoned proxy");
        },
      },
    );
    const poisonedCoercion = {
      [Symbol.toPrimitive](): never {
        throw new Error("poisoned coercion");
      },
      toString(): never {
        throw new Error("poisoned toString");
      },
    };

    expect(formatDiagnostic(poisonedGetter)).toBe("preserved message");
    expect(formatDiagnostic(hostileProxy)).toBe("[unstringifiable error]");
    expect(formatDiagnostic(poisonedCoercion)).toBe("[object Object]");
    expect(formatDiagnostic(Object.create(null))).toBe("[object Object]");
  });
});

describe("shouldIgnoreUnhandledRejection", () => {
  it("classifies serialized provider-credit errors through safe properties", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "AI_APICallError",
        statusCode: 402,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
        cause: { message: "AI_RetryError: insufficient credits" },
      }),
    ).toBe(true);
  });

  it("does not throw while traversing a hostile rejection", () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("poisoned rejection");
        },
      },
    );
    expect(shouldIgnoreUnhandledRejection(hostile)).toBe(false);
  });
});
