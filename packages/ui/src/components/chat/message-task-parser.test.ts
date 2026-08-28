/** Verifies findTaskRegions through the package's configured test harness. */
// Unit tests for the `[TASK:<id>]<title>[/TASK]` marker parser: region
// detection, id/title extraction, and the MAX_TASK_TITLE_LEN cap. Pure
// functions over string fixtures — no model, no render.

import { describe, expect, it } from "vitest";
import { findTaskRegions, MAX_TASK_TITLE_LEN } from "./message-task-parser";

describe("findTaskRegions", () => {
  it("returns no regions for plain prose", () => {
    expect(findTaskRegions("This has no widget block.")).toEqual([]);
  });

  it("returns no regions for empty input", () => {
    expect(findTaskRegions("")).toEqual([]);
  });

  it("parses a well-formed [TASK:id]title[/TASK] block", () => {
    const id = "0123abcd-1234-5678-9abc-deadbeefcafe";
    const text = `prefix [TASK:${id}]Build planner app[/TASK] suffix`;
    const regions = findTaskRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      threadId: id,
      title: "Build planner app",
    });
    expect(text.slice(regions[0].start, regions[0].end)).toBe(
      `[TASK:${id}]Build planner app[/TASK]`,
    );
  });

  it("trims whitespace inside the title", () => {
    const id = "0123abcd-1234-5678-9abc-deadbeefcafe";
    const regions = findTaskRegions(
      `[TASK:${id}]\n   indented title  \n[/TASK]`,
    );
    expect(regions[0].title).toBe("indented title");
  });

  it("rejects threadIds that don't look like UUID hex", () => {
    expect(findTaskRegions("[TASK:not a uuid]hello[/TASK]")).toEqual([]);
    expect(findTaskRegions("[TASK:UPPERCASE]hello[/TASK]")).toEqual([]);
    expect(findTaskRegions("[TASK:abc]hello[/TASK]")).toEqual([]);
  });

  it("ignores unterminated open tags", () => {
    const id = "0123abcd-1234-5678-9abc-deadbeefcafe";
    expect(findTaskRegions(`[TASK:${id}]Build planner app`)).toEqual([]);
  });

  it("ignores empty titles", () => {
    const id = "0123abcd-1234-5678-9abc-deadbeefcafe";
    expect(findTaskRegions(`[TASK:${id}][/TASK]`)).toEqual([]);
    expect(findTaskRegions(`[TASK:${id}]   [/TASK]`)).toEqual([]);
  });

  it("parses multiple blocks in one message", () => {
    const a = "0123abcd-1234-5678-9abc-deadbeefcafe";
    const b = "fedcba98-7654-3210-9abc-c0ffeec0ffee";
    const text = `first [TASK:${a}]Alpha[/TASK] then [TASK:${b}]Beta[/TASK]`;
    const regions = findTaskRegions(text);
    expect(regions.map((r) => r.threadId)).toEqual([a, b]);
    expect(regions.map((r) => r.title)).toEqual(["Alpha", "Beta"]);
  });

  it("truncates overlong titles", () => {
    const id = "0123abcd-1234-5678-9abc-deadbeefcafe";
    const long = "x".repeat(MAX_TASK_TITLE_LEN + 50);
    const regions = findTaskRegions(`[TASK:${id}]${long}[/TASK]`);
    expect(regions[0].title.length).toBe(MAX_TASK_TITLE_LEN);
    expect(regions[0].title.endsWith("…")).toBe(true);
  });

  it("preserves well-formed Unicode when truncating title at surrogate boundary", () => {
    const fox = String.fromCodePoint(0x1f98a);
    const long = "a".repeat(MAX_TASK_TITLE_LEN - 2) + fox + "x".repeat(50);
    const id = "0123abcd-1234-5678-9abc-deadbeefcafe";
    const regions = findTaskRegions(`[TASK:${id}]${long}[/TASK]`);
    const title = regions[0].title;
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(MAX_TASK_TITLE_LEN);
    // well-formed: no lone surrogate at end
    for (let i = 0; i < title.length; i++) {
      const c = title.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        expect(title.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(title.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      }
    }
    expect(() => JSON.stringify(title)).not.toThrow();
  });
});
