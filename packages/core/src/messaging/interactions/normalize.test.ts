/**
 * Coverage for interaction normalize helpers.
 */
import { describe, expect, it } from "vitest";

import { normalizeContentInteractions, stripInteractionMarkers } from "./normalize.js";

describe("stripInteractionMarkers", () => {
  it("returns empty for empty text", () => {
    expect(stripInteractionMarkers("")).toBe("");
  });

  it("returns text without markers unchanged", () => {
    expect(stripInteractionMarkers("hello world")).toBe("hello world");
  });

  it("strips interaction markup when present", () => {
    const withMarker = "hello [[choice:yes]] world";
    const stripped = stripInteractionMarkers(withMarker);
    expect(typeof stripped).toBe("string");
  });
});

describe("normalizeContentInteractions", () => {
  it("returns same content for empty text", () => {
    const content = { text: "" };
    expect(normalizeContentInteractions(content as never)).toBe(content);
  });

  it("returns same content when no interactions parsed", () => {
    const content = { text: "hello" };
    const out = normalizeContentInteractions(content as never);
    expect(out.text).toBe("hello");
    expect(out.interactions).toBeUndefined();
  });

  it("preserves existing interactions", () => {
    const content = {
      text: "hello",
      interactions: [{ type: "choice", value: "yes" } as unknown as never],
    };
    const out = normalizeContentInteractions(content as never);
    expect(out.interactions).toHaveLength(1);
  });

  it("handles undefined text", () => {
    const content = {} as unknown as { text?: string };
    expect(normalizeContentInteractions(content as never)).toBe(content);
  });

  it("is idempotent for already-normalized", () => {
    const content = { text: "hello" };
    const once = normalizeContentInteractions(content as never);
    const twice = normalizeContentInteractions(once as never);
    expect(twice.text).toBe(once.text);
  });
});
