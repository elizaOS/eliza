/** Unit coverage for the best-effort-hydration fetch failure classifier; deterministic, no I/O. */

import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client-types-core";
import { isTransientOptionalFetchFailure } from "./transient-fetch";

describe("isTransientOptionalFetchFailure", () => {
  it("rejects values that are not Error instances, including ApiError-shaped plain objects", () => {
    expect(isTransientOptionalFetchFailure(null)).toBe(false);
    expect(isTransientOptionalFetchFailure(undefined)).toBe(false);
    expect(isTransientOptionalFetchFailure("Failed to fetch")).toBe(false);
    expect(
      isTransientOptionalFetchFailure({ name: "ApiError", kind: "timeout" }),
    ).toBe(false);
  });

  it("recognises a raw TypeError from fetch() rejecting before any response", () => {
    expect(
      isTransientOptionalFetchFailure(new TypeError("Failed to fetch")),
    ).toBe(true);
    expect(isTransientOptionalFetchFailure(new TypeError("NetworkError"))).toBe(
      true,
    );
    expect(isTransientOptionalFetchFailure(new TypeError("Load failed"))).toBe(
      true,
    );
  });

  it("matches those raw messages case-insensitively", () => {
    expect(
      isTransientOptionalFetchFailure(new TypeError("failed to fetch")),
    ).toBe(true);
    expect(isTransientOptionalFetchFailure(new TypeError("LOAD FAILED"))).toBe(
      true,
    );
  });

  it("does not treat a programming TypeError as transient", () => {
    expect(
      isTransientOptionalFetchFailure(
        new TypeError("Cannot read properties of undefined (reading 'map')"),
      ),
    ).toBe(false);
  });

  it("requires the whole message to be the transient phrase, not a prefix", () => {
    expect(
      isTransientOptionalFetchFailure(new TypeError(" Failed to fetch")),
    ).toBe(false);
    expect(
      isTransientOptionalFetchFailure(
        new TypeError("Failed to fetch: net::ERR_CONNECTION_RESET"),
      ),
    ).toBe(false);
  });

  it("treats an ApiError timeout as transient regardless of message wording", () => {
    expect(
      isTransientOptionalFetchFailure(
        new ApiError({
          kind: "timeout",
          path: "/api/agents",
          message: "Request timed out after 8000ms",
        }),
      ),
    ).toBe(true);
  });

  it("treats an ApiError network failure that never got a response as transient", () => {
    for (const message of ["Failed to fetch", "request aborted"]) {
      expect(
        isTransientOptionalFetchFailure(
          new ApiError({
            kind: "network",
            path: "/api/agents",
            message,
          }),
        ),
      ).toBe(true);
    }
  });

  it("does not treat an ApiError network failure carrying another message as transient", () => {
    expect(
      isTransientOptionalFetchFailure(
        new ApiError({
          kind: "network",
          path: "/api/agents",
          message: "socket hang up mid-response",
        }),
      ),
    ).toBe(false);
  });

  it("does not treat http or parse ApiErrors as transient", () => {
    expect(
      isTransientOptionalFetchFailure(
        new ApiError({
          kind: "http",
          status: 503,
          path: "/api/agents",
          message: "Service Unavailable",
        }),
      ),
    ).toBe(false);
    expect(
      isTransientOptionalFetchFailure(
        new ApiError({
          kind: "parse",
          path: "/api/agents",
          message: "Unexpected token < in JSON",
        }),
      ),
    ).toBe(false);
  });

  it("keys on the error name, so an ordinary Error with a kind property is still surfaced", () => {
    const lookalike = Object.assign(new Error("Request aborted"), {
      kind: "network",
    });
    expect(isTransientOptionalFetchFailure(lookalike)).toBe(false);
  });

  it("does not classify unrelated error types as transient", () => {
    expect(
      isTransientOptionalFetchFailure(new RangeError("out of range")),
    ).toBe(false);
    expect(isTransientOptionalFetchFailure(new Error("boom"))).toBe(false);
  });
});
