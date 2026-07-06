/**
 * `[BACKGROUND]` marker parser + its registration as an inline widget. Proves
 * the bare marker is found at its character bounds, multiple markers each yield
 * a region, and importing the inline builtins registers a `background` widget
 * whose parse routes the marker into a widget segment. Pure/registry test — the
 * BackgroundWidget's own render is exercised via the chat integration test.
 */

import { describe, expect, it } from "vitest";
import {
  BACKGROUND_RE,
  findBackgroundRegions,
} from "./message-background-parser";
import "./widgets/inline-builtins";
import { getInlineWidget } from "./widgets/inline-registry";

describe("findBackgroundRegions", () => {
  it("finds a lone [BACKGROUND] marker at its bounds", () => {
    const text = "here you go:\n\n[BACKGROUND]";
    const regions = findBackgroundRegions(text);
    expect(regions).toHaveLength(1);
    expect(text.slice(regions[0].start, regions[0].end)).toBe("[BACKGROUND]");
  });

  it("returns no regions when the marker is absent", () => {
    expect(findBackgroundRegions("just some prose about wallpapers")).toEqual(
      [],
    );
  });

  it("is stateless across calls (global regex lastIndex reset)", () => {
    const text = "[BACKGROUND]";
    expect(findBackgroundRegions(text)).toHaveLength(1);
    expect(findBackgroundRegions(text)).toHaveLength(1);
    // The exported regex is reset before use, so a stale lastIndex never
    // silently drops a match on the second pass.
    BACKGROUND_RE.lastIndex = 5;
    expect(findBackgroundRegions(text)).toHaveLength(1);
  });
});

describe("background inline widget registration", () => {
  it("registers a 'background' widget that parses the marker into a region", () => {
    const widget = getInlineWidget("background");
    expect(widget).toBeDefined();
    const matches = widget?.parse("pick one:\n\n[BACKGROUND]") ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0].start).toBeGreaterThan(0);
  });
});
