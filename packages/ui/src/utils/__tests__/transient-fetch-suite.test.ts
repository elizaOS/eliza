/**
 * Unit tests for transient optional fetch failure detection.
 * Validates TypeError network failure shapes, ApiError timeout and network kinds, and rejection guards.
 */
import { describe, expect, it } from "vitest";
import { isTransientOptionalFetchFailure } from "../transient-fetch.ts";

describe("transient-fetch", () => {
  describe("isTransientOptionalFetchFailure", () => {
    it("identifies standard browser TypeError network exceptions", () => {
      const typeErr1 = new TypeError("Failed to fetch");
      const typeErr2 = new TypeError("NetworkError");
      const typeErr3 = new TypeError("Load failed");
      const typeErrLower = new TypeError("failed to fetch");

      expect(isTransientOptionalFetchFailure(typeErr1)).toBe(true);
      expect(isTransientOptionalFetchFailure(typeErr2)).toBe(true);
      expect(isTransientOptionalFetchFailure(typeErr3)).toBe(true);
      expect(isTransientOptionalFetchFailure(typeErrLower)).toBe(true);
    });

    it("identifies ApiError with kind=timeout", () => {
      const timeoutErr = new Error("Request timed out after 5000ms");
      timeoutErr.name = "ApiError";
      Object.assign(timeoutErr, { kind: "timeout" });

      expect(isTransientOptionalFetchFailure(timeoutErr)).toBe(true);
    });

    it("identifies ApiError with kind=network and matching message", () => {
      const fetchErr = new Error("Failed to fetch");
      fetchErr.name = "ApiError";
      Object.assign(fetchErr, { kind: "network" });

      const abortErr = new Error("Request aborted");
      abortErr.name = "ApiError";
      Object.assign(abortErr, { kind: "network" });

      expect(isTransientOptionalFetchFailure(fetchErr)).toBe(true);
      expect(isTransientOptionalFetchFailure(abortErr)).toBe(true);
    });

    it("returns false for non-transient ApiErrors", () => {
      const authErr = new Error("Unauthorized");
      authErr.name = "ApiError";
      Object.assign(authErr, { kind: "auth" });

      const serverErr = new Error("Internal Server Error");
      serverErr.name = "ApiError";
      Object.assign(serverErr, { kind: "server" });

      expect(isTransientOptionalFetchFailure(authErr)).toBe(false);
      expect(isTransientOptionalFetchFailure(serverErr)).toBe(false);
    });

    it("returns false for unrelated TypeErrors and non-Error primitives", () => {
      expect(
        isTransientOptionalFetchFailure(
          new TypeError("Cannot read properties of undefined"),
        ),
      ).toBe(false);
      expect(isTransientOptionalFetchFailure(new Error("Generic error"))).toBe(
        false,
      );
      expect(isTransientOptionalFetchFailure("Failed to fetch")).toBe(false);
      expect(isTransientOptionalFetchFailure(null)).toBe(false);
      expect(isTransientOptionalFetchFailure(undefined)).toBe(false);
    });
  });
});
