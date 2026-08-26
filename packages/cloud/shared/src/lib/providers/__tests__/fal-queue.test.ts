/**
 * Exercises FAL queue option extraction and credential precedence contracts.
 */
import { describe, expect, it } from "bun:test";
import { falQueueOptionsFromApiKeys } from "../fal-queue";

describe("falQueueOptionsFromApiKeys", () => {
  it("prefers the canonical FAL_API_KEY when both deployment keys exist", () => {
    const options = falQueueOptionsFromApiKeys({
      FAL_KEY: "stale-legacy-key",
      FAL_API_KEY: "canonical-key",
    });
    expect(options.apiKey).toBe("canonical-key");
  });

  it("falls back to FAL_KEY when FAL_API_KEY is not set", () => {
    const options = falQueueOptionsFromApiKeys({
      FAL_KEY: "legacy-key",
    });
    expect(options.apiKey).toBe("legacy-key");
  });

  it("throws when neither key is provided", () => {
    expect(() => falQueueOptionsFromApiKeys({})).toThrow(
      "fal is not configured: missing FAL_KEY / FAL_API_KEY",
    );
  });
});
