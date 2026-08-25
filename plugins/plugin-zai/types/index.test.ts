/**
 * Trust-boundary coverage for the z.ai configuration guards:
 * `assertValidApiKey` is the credential gate that stops an unset/blank
 * ZAI_API_KEY from reaching the provider, and `createModelName` rejects
 * empty model names before they can be routed to the API.
 */
import { describe, expect, it } from "vitest";

import { assertValidApiKey, createModelName } from "./index";

describe("assertValidApiKey", () => {
  it("accepts a configured non-blank key", () => {
    expect(() => assertValidApiKey("sk-zai-123")).not.toThrow();
  });

  it("rejects a missing key", () => {
    expect(() => assertValidApiKey(undefined)).toThrow(
      "ZAI_API_KEY is required but not configured"
    );
  });

  it("rejects a null key", () => {
    expect(() => assertValidApiKey(null)).toThrow("ZAI_API_KEY is required but not configured");
  });

  it("rejects an empty key", () => {
    expect(() => assertValidApiKey("")).toThrow("ZAI_API_KEY is required but not configured");
  });

  it("rejects a whitespace-only key", () => {
    expect(() => assertValidApiKey("   ")).toThrow("ZAI_API_KEY is required but not configured");
  });

  it("narrows the argument type when it passes", () => {
    const key = "sk-zai-456" as string;
    assertValidApiKey(key);
    // Type-level assertion: after the guard the value is ValidatedApiKey.
    expect(key.length).toBeGreaterThan(0);
  });
});

describe("createModelName", () => {
  it("returns a non-empty model name unchanged", () => {
    expect(createModelName("llama-3.1-8b")).toBe("llama-3.1-8b");
  });

  it("rejects an empty model name", () => {
    expect(() => createModelName("")).toThrow("Model name cannot be empty");
  });

  it("rejects a whitespace-only model name", () => {
    expect(() => createModelName("  \t ")).toThrow("Model name cannot be empty");
  });
});
