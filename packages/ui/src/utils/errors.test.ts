/**
 * Unit coverage for the ui error-helper boundary (`utils/errors.ts`) that ui
 * consumers such as ConversationsSidebar import instead of reaching into
 * `@elizaos/shared` directly. Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import { errorMessage, isRedirectResponse, isTimeoutError } from "./errors";

describe("errorMessage", () => {
  it("extracts the message of an Error instance", () => {
    expect(errorMessage(new Error("Agent request failed"))).toBe(
      "Agent request failed",
    );
    expect(errorMessage(new TypeError("not a function"))).toBe(
      "not a function",
    );
  });

  it("stringifies non-Error caught values", () => {
    expect(errorMessage("Custom error string")).toBe("Custom error string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(true)).toBe("true");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ code: "X" })).toBe("[object Object]");
  });

  it("preserves an intentionally empty Error message", () => {
    expect(errorMessage(new Error())).toBe("");
  });

  it("falls back safely when primitive conversion throws", () => {
    const poisoned = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "toString" || prop === Symbol.toPrimitive) {
            throw new Error("hostile toString");
          }
          return undefined;
        },
      },
    );
    expect(errorMessage(poisoned)).toBe("[object Object]");

    expect(errorMessage(Object.create(null))).toBe("[object Object]");
  });

  it("falls back safely when an Error's message getter itself throws", () => {
    class HostileMessage extends Error {
      override get message(): string {
        throw new Error("getter exploded");
      }
    }
    const hostile = new HostileMessage("shadowed");
    // The Error constructor installs `message` as an own property that
    // shadows the prototype getter; remove it so the throwing getter runs.
    delete (hostile as { message?: unknown }).message;
    expect(errorMessage(hostile)).toBe("[object Error]");
  });
});

describe("isTimeoutError", () => {
  it("accepts Error instances named TimeoutError or AbortError regardless of message", () => {
    const timeoutErr = new Error("gateway said no");
    timeoutErr.name = "TimeoutError";
    expect(isTimeoutError(timeoutErr)).toBe(true);

    const abortErr = new Error("user cancelled");
    abortErr.name = "AbortError";
    expect(isTimeoutError(abortErr)).toBe(true);
  });

  it("matches timeout wording in Error messages case-insensitively", () => {
    expect(isTimeoutError(new Error("Request TIMED OUT after 5000ms"))).toBe(
      true,
    );
    expect(isTimeoutError(new Error("Socket Timeout"))).toBe(true);
    expect(isTimeoutError(new Error("Connection refused"))).toBe(false);
  });

  it("matches duck-typed objects by name or string message", () => {
    expect(isTimeoutError({ name: "TimeoutError" })).toBe(true);
    expect(isTimeoutError({ name: "AbortError" })).toBe(true);
    expect(isTimeoutError({ message: "operation timed out" })).toBe(true);
    expect(isTimeoutError({ message: "invalid payload" })).toBe(false);
  });

  it("rejects objects whose message is not a string", () => {
    expect(isTimeoutError({ message: 42 })).toBe(false);
    expect(isTimeoutError({})).toBe(false);
    expect(isTimeoutError(["timeout"])).toBe(false);
  });

  it("classifies plain strings by their wording", () => {
    expect(isTimeoutError("request timed out")).toBe(true);
    expect(isTimeoutError("Network TIMEOUT")).toBe(true);
    expect(isTimeoutError("Bad request")).toBe(false);
  });

  it("short-circuits on falsy and non-string primitives", () => {
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError("")).toBe(false);
    expect(isTimeoutError(0)).toBe(false);
    expect(isTimeoutError(123)).toBe(false);
    expect(isTimeoutError(false)).toBe(false);
  });
});

describe("isRedirectResponse", () => {
  it("accepts every 3xx status class including the range boundaries", () => {
    expect(isRedirectResponse({ status: 300 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 301 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 302 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 303 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 307 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 308 } as Response)).toBe(true);
    expect(isRedirectResponse({ status: 399 } as Response)).toBe(true);
  });

  it("rejects statuses outside [300, 400)", () => {
    expect(isRedirectResponse({ status: 200 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 299 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 400 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 404 } as Response)).toBe(false);
    expect(isRedirectResponse({ status: 500 } as Response)).toBe(false);
  });

  it("rejects missing, non-numeric, and non-finite statuses", () => {
    expect(isRedirectResponse(null as unknown as Response)).toBe(false);
    expect(isRedirectResponse(undefined as unknown as Response)).toBe(false);
    expect(isRedirectResponse({} as Response)).toBe(false);
    expect(isRedirectResponse({ status: "302" } as unknown as Response)).toBe(
      false,
    );
    expect(
      isRedirectResponse({ status: Number.NaN } as unknown as Response),
    ).toBe(false);
    expect(
      isRedirectResponse({
        status: Number.POSITIVE_INFINITY,
      } as unknown as Response),
    ).toBe(false);
  });
});
