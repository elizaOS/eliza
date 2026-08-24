/**
 * Unit tests for transient optional fetch failure classification.
 */
import { describe, expect, it } from "vitest";
import { isTransientOptionalFetchFailure } from "../transient-fetch.ts";

describe("transient-fetch", () => {
  describe("isTransientOptionalFetchFailure", () => {
    it("identifies browser raw TypeError network drop messages", () => {
      expect(
        isTransientOptionalFetchFailure(new TypeError("Failed to fetch")),
      ).toBe(true);
      expect(
        isTransientOptionalFetchFailure(new TypeError("NetworkError")),
      ).toBe(true);
      expect(
        isTransientOptionalFetchFailure(new TypeError("Load failed")),
      ).toBe(true);
    });

    it("identifies ApiError with kind timeout", () => {
      const timeoutError = Object.assign(
        new Error("Request timed out after 5000ms"),
        {
          name: "ApiError",
          kind: "timeout",
        },
      );
      expect(isTransientOptionalFetchFailure(timeoutError)).toBe(true);
    });

    it("identifies ApiError with kind network and aborted / fetch failure message", () => {
      const networkError = Object.assign(new Error("Failed to fetch"), {
        name: "ApiError",
        kind: "network",
      });
      const abortError = Object.assign(new Error("Request aborted"), {
        name: "ApiError",
        kind: "network",
      });
      expect(isTransientOptionalFetchFailure(networkError)).toBe(true);
      expect(isTransientOptionalFetchFailure(abortError)).toBe(true);
    });

    it("returns false for non-transient API errors or generic errors", () => {
      const authError = Object.assign(new Error("Unauthorized"), {
        name: "ApiError",
        kind: "http",
        status: 401,
      });
      expect(isTransientOptionalFetchFailure(authError)).toBe(false);
      expect(
        isTransientOptionalFetchFailure(new Error("Syntax error in payload")),
      ).toBe(false);
      expect(
        isTransientOptionalFetchFailure(
          new TypeError("Cannot read properties of null"),
        ),
      ).toBe(false);
      expect(isTransientOptionalFetchFailure(null)).toBe(false);
      expect(isTransientOptionalFetchFailure(undefined)).toBe(false);
    });
  });
});
