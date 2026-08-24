import { describe, expect, it } from "vitest";
import {
  detectEnableIntent,
  extractSlugFromMessage,
} from "./parse-helpers.ts";

describe("extractSlugFromMessage", () => {
  it("extracts quoted slugs", () => {
    expect(extractSlugFromMessage('use the "my-skill" now')).toBe("my-skill");
    expect(extractSlugFromMessage("enable 'another-skill'")).toBe(
      "another-skill",
    );
  });

  it("strips filler and action words", () => {
    expect(extractSlugFromMessage("please enable the skill called focus-mode")).toBe(
      "focus-mode",
    );
  });

  it("bounds quoted captures to 64 chars", () => {
    const long = "x".repeat(100);
    expect(extractSlugFromMessage(`"${long}"`)).toBeNull();
  });

  it("returns null for empty or unusable messages", () => {
    expect(extractSlugFromMessage("")).toBeNull();
    expect(extractSlugFromMessage("please can you the skill")).toBeNull();
  });
});

describe("detectEnableIntent", () => {
  it("detects enable intent", () => {
    expect(detectEnableIntent("please enable focus mode")).toBe(true);
    expect(detectEnableIntent("activate it now")).toBe(true);
    expect(detectEnableIntent("turn on the skill")).toBe(true);
  });

  it("detects disable intent", () => {
    expect(detectEnableIntent("disable focus mode")).toBe(false);
    expect(detectEnableIntent("stop it")).toBe(false);
    expect(detectEnableIntent("turn off the skill")).toBe(false);
  });

  it("returns null for ambiguous text", () => {
    expect(detectEnableIntent("hello world")).toBeNull();
    expect(detectEnableIntent("install the skill")).toBeNull();
  });
});
