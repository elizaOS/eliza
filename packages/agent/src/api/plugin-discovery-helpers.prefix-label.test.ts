/**
 * Tests for prefixLabel with regex special character suffixes.
 */

import { describe, expect, it } from "vitest";
import { prefixLabel } from "./plugin-discovery-helpers.ts";

describe("prefixLabel regex safety", () => {
  it("strips ordinary suffixes correctly", () => {
    expect(prefixLabel("anthropic_api_key", "_api_key")).toBe("Anthropic");
    expect(prefixLabel("openai_key", "_key")).toBe("Openai");
  });

  it("handles suffixes containing regex special characters without crashing or misinterpreting", () => {
    expect(prefixLabel("config.json", ".json")).toBe("Config");
    expect(prefixLabel("service+prod", "+prod")).toBe("Service");
    expect(prefixLabel("key(secret)", "(secret)")).toBe("Key");
    expect(prefixLabel("target[0]", "[0]")).toBe("Target");
    expect(prefixLabel("special$val", "$val")).toBe("Special");
  });

  it("falls back to key when nothing remains after stripping", () => {
    expect(prefixLabel("_api_key", "_api_key")).toBe("_api_key");
  });
});
