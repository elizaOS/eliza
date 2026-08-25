/**
 * Colocated coverage for app-core's process-handler error utilities. The
 * module re-exports `formatUncaughtError` and `shouldIgnoreUnhandledRejection`
 * from `@elizaos/shared`; this suite drives the app-core entry so
 * `run-main.ts` / `dev-server.ts` keep resolving the same functions. Walks
 * every classification branch (empty queue, single node, DFS `pop` order,
 * cycle skip, missing cause/errors, credit-signal variants) with real values.
 * No mocks.
 */
import {
  formatUncaughtError as sharedFormatUncaughtError,
  shouldIgnoreUnhandledRejection as sharedShouldIgnoreUnhandledRejection,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import * as errorHandlers from "./error-handlers";
import {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "./error-handlers";

describe("app-core error-handlers re-export", () => {
  it("re-exports the same runtime functions as @elizaos/shared", () => {
    expect(formatUncaughtError).toBe(sharedFormatUncaughtError);
    expect(shouldIgnoreUnhandledRejection).toBe(
      sharedShouldIgnoreUnhandledRejection,
    );
  });

  it("exposes only the two process-handler symbols", () => {
    expect(Object.keys(errorHandlers).sort()).toEqual([
      "formatUncaughtError",
      "shouldIgnoreUnhandledRejection",
    ]);
  });
});

describe("formatUncaughtError", () => {
  it("prefers a nonblank stack over a message", () => {
    expect(
      formatUncaughtError({ stack: "stack trace", message: "message" }),
    ).toBe("stack trace");
  });

  it("falls through to message when stack is blank or missing", () => {
    expect(formatUncaughtError({ stack: "   ", message: "message" })).toBe(
      "message",
    );
    expect(formatUncaughtError({ stack: "", message: "message" })).toBe(
      "message",
    );
    expect(formatUncaughtError({ message: "message" })).toBe("message");
  });

  it("preserves primitive and nullish diagnostics", () => {
    expect(formatUncaughtError("failure")).toBe("failure");
    expect(formatUncaughtError(null)).toBe("null");
    expect(formatUncaughtError(undefined)).toBe("undefined");
    expect(formatUncaughtError(402)).toBe("402");
    expect(formatUncaughtError(true)).toBe("true");
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

    expect(formatUncaughtError(poisonedGetter)).toBe("preserved message");
    expect(formatUncaughtError(hostileProxy)).toBe("[unstringifiable error]");
    expect(formatUncaughtError(poisonedCoercion)).toBe("[object Object]");
    expect(formatUncaughtError(Object.create(null))).toBe("[object Object]");
  });

  it("formats a real Error from its stack, not just the message", () => {
    const error = new Error("runtime boom");
    const formatted = formatUncaughtError(error);
    expect(formatted).toContain("runtime boom");
    expect(formatted).toContain("Error");
  });
});

describe("shouldIgnoreUnhandledRejection", () => {
  it("returns false for an empty-queue walk (nullish and primitive reasons)", () => {
    expect(shouldIgnoreUnhandledRejection(undefined)).toBe(false);
    expect(shouldIgnoreUnhandledRejection(null)).toBe(false);
    expect(shouldIgnoreUnhandledRejection(402)).toBe(false);
    expect(shouldIgnoreUnhandledRejection("ordinary failure")).toBe(false);
  });

  it("returns false for a single ordinary Error", () => {
    expect(
      shouldIgnoreUnhandledRejection(new Error("TypeError: x is undefined")),
    ).toBe(false);
  });

  it("does not ignore a provider error that carries no credit signal", () => {
    expect(
      shouldIgnoreUnhandledRejection(
        new Error("AI_NoOutputGeneratedError: No output generated"),
      ),
    ).toBe(false);
    expect(
      shouldIgnoreUnhandledRejection(
        new Error("AI_APICallError: request failed"),
      ),
    ).toBe(false);
    expect(shouldIgnoreUnhandledRejection({ message: "AI_RetryError" })).toBe(
      false,
    );
  });

  it("ignores a string reason that is both a provider error and a credit signal", () => {
    expect(
      shouldIgnoreUnhandledRejection("AI_APICallError: payment required"),
    ).toBe(true);
    expect(
      shouldIgnoreUnhandledRejection("AI_RetryError: insufficient credits"),
    ).toBe(true);
    expect(
      shouldIgnoreUnhandledRejection("No output generated: out of credits"),
    ).toBe(true);
  });

  it("matches every credit-signal spelling on a provider-formatted string", () => {
    const signals = [
      "insufficient credits",
      "insufficient credit",
      "insufficient quota",
      "insufficient_credits",
      "insufficient_quota",
      "out of credits",
      "payment required",
      "statuscode: 402",
      "StatusCode:402",
    ];
    for (const signal of signals) {
      expect(shouldIgnoreUnhandledRejection(`AI_APICallError: ${signal}`)).toBe(
        true,
      );
    }
  });

  it("does not treat concatenated credit-like tokens as a signal", () => {
    expect(
      shouldIgnoreUnhandledRejection("AI_APICallError: insufficientcredits"),
    ).toBe(false);
    expect(
      shouldIgnoreUnhandledRejection("AI_APICallError: statuscode: 4020"),
    ).toBe(false);
  });

  it("ignores a provider object whose statusCode is the number 402", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "AI_APICallError",
        statusCode: 402,
      }),
    ).toBe(true);
  });

  it("does not treat a string or other 402-like statusCode as a match", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "AI_APICallError",
        statusCode: "402",
      }),
    ).toBe(false);
    expect(
      shouldIgnoreUnhandledRejection({
        message: "AI_APICallError",
        statusCode: 403,
      }),
    ).toBe(false);
  });

  it("ignores a provider object whose responseBody string carries a credit signal", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "AI_APICallError",
        responseBody: "insufficient credits",
      }),
    ).toBe(true);
  });

  it("ignores a non-string responseBody and a credit signal on a non-provider object", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "AI_APICallError",
        responseBody: { text: "insufficient credits" },
      }),
    ).toBe(false);
    expect(
      shouldIgnoreUnhandledRejection({
        message: "ordinary request failed",
        statusCode: 402,
        responseBody: "payment required",
      }),
    ).toBe(false);
  });

  it("walks a single nested cause", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
        cause: { message: "AI_RetryError: insufficient credits" },
      }),
    ).toBe(true);
  });

  it("does not inherit statusCode 402 from a nested non-provider cause", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "AI_APICallError",
        cause: { message: "nope", statusCode: 402 },
      }),
    ).toBe(false);
  });

  it("walks an errors array (including a single-element queue)", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
        errors: [{ message: "AI_APICallError", statusCode: 402 }],
      }),
    ).toBe(true);
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
        errors: [],
      }),
    ).toBe(false);
  });

  it("finds a credit match regardless of DFS pop order in a multi-error queue", () => {
    const credit = { message: "AI_APICallError: payment required" };
    const ordinary = { message: "timeout" };
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
        errors: [credit, ordinary],
      }),
    ).toBe(true);
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
        errors: [ordinary, credit],
      }),
    ).toBe(true);
  });

  it("skips a missing errors property and a non-array errors value", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "AI_APICallError: request failed",
        errors: "not-an-array",
      }),
    ).toBe(false);
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
      }),
    ).toBe(false);
  });

  it("finds provider credit exhaustion inside a generic AggregateError", () => {
    const credit = Object.assign(new Error("AI_APICallError: request failed"), {
      statusCode: 402,
    });
    expect(
      shouldIgnoreUnhandledRejection(
        new AggregateError([credit], "All provider attempts failed"),
      ),
    ).toBe(true);
    expect(
      shouldIgnoreUnhandledRejection(
        new AggregateError(
          [
            Object.assign(new Error("ordinary request failed"), {
              statusCode: 402,
            }),
          ],
          "All requests failed",
        ),
      ),
    ).toBe(false);
  });

  it("classifies a string child of an AggregateError the same as a top-level string", () => {
    const creditReason = "AI_APICallError: payment required";
    expect(
      shouldIgnoreUnhandledRejection(
        new AggregateError([creditReason], "All provider attempts failed"),
      ),
    ).toBe(true);
  });

  it("skips a cyclic cause instead of overflowing the walk", () => {
    const cyclic: { message: string; cause?: unknown } = {
      message: "ordinary loop",
    };
    cyclic.cause = cyclic;
    expect(shouldIgnoreUnhandledRejection(cyclic)).toBe(false);

    const creditCycle: { message: string; cause?: unknown } = {
      message: "AI_APICallError: payment required",
    };
    creditCycle.cause = creditCycle;
    expect(shouldIgnoreUnhandledRejection(creditCycle)).toBe(true);
  });

  it("skips a duplicate object already seen in the errors queue", () => {
    const credit = { message: "AI_APICallError: payment required" };
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
        errors: [credit, credit],
      }),
    ).toBe(true);
    const ordinary = { message: "timeout" };
    expect(
      shouldIgnoreUnhandledRejection({
        message: "wrapper",
        errors: [ordinary, ordinary],
      }),
    ).toBe(false);
  });

  it("walks a deeper cause chain before giving up", () => {
    expect(
      shouldIgnoreUnhandledRejection({
        message: "outer",
        cause: {
          message: "middle",
          cause: { message: "AI_APICallError", statusCode: 402 },
        },
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

  it("classifies a function reason from its message without walking nested fields", () => {
    const providerFn = Object.assign(() => {}, {
      message: "AI_APICallError: payment required",
      statusCode: 403,
      cause: { message: "should not need to be walked" },
    });
    expect(shouldIgnoreUnhandledRejection(providerFn)).toBe(true);
  });
});
