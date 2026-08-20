/** Exercises stale-binary rejection for packaged desktop evidence. */

import { describe, expect, test } from "vitest";
import { assertCurrentPackagedRevision } from "./packaged-revision";

describe("assertCurrentPackagedRevision", () => {
  test("accepts the app-reported build stamp for the checkout", () => {
    expect(
      assertCurrentPackagedRevision(
        {
          buildId: "build-1",
          commit: "abcdef1234567890abcdef1234567890abcdef12",
        },
        "abcdef1234567890abcdef1234567890abcdef12",
      ),
    ).toEqual({
      buildId: "build-1",
      commit: "abcdef1234567890abcdef1234567890abcdef12",
    });
  });

  test("rejects an abbreviated revision even when its prefix matches", () => {
    expect(() =>
      assertCurrentPackagedRevision(
        { buildId: "build-1", commit: "abcdef1234" },
        "abcdef1234567890abcdef1234567890abcdef12",
      ),
    ).toThrow(/does not match checkout/);
  });

  test("rejects an operator assertion when the running binary is stale", () => {
    expect(() =>
      assertCurrentPackagedRevision(
        { buildId: "stale-build", commit: "1111111111" },
        "abcdef1234567890abcdef1234567890abcdef12",
      ),
    ).toThrow(/does not match checkout/);
  });
});
