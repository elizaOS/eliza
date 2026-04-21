/**
 * Unit tests for window query matching and alias exports.
 */
import { describe, expect, it } from "vitest";
import {
  arrangeWindows,
  arrange_windows,
  findWindowsByQuery,
  focusWindow,
  listWindows,
  list_windows,
  moveWindow,
  move_window,
  restoreWindow,
  restore_window,
  resolveWindowMatch,
  switchWindow,
  switch_to_window,
  focus_window,
} from "../platform/windows-list.js";

const sampleWindows = [
  { id: "101", title: "Docs - Milady", app: "Chrome" },
  { id: "202", title: "Terminal", app: "iTerm2" },
  { id: "303", title: "Settings", app: "System Settings" },
];

describe("window query matching", () => {
  it("matches by title, app, and id", () => {
    expect(findWindowsByQuery("docs", sampleWindows)).toEqual([sampleWindows[0]]);
    expect(findWindowsByQuery("chrome", sampleWindows)).toEqual([sampleWindows[0]]);
    expect(findWindowsByQuery("202", sampleWindows)).toEqual([sampleWindows[1]]);
  });

  it("returns the first matching window for resolveWindowMatch", () => {
    expect(resolveWindowMatch("terminal", sampleWindows)).toEqual(sampleWindows[1]);
    expect(resolveWindowMatch("settings", sampleWindows)).toEqual(sampleWindows[2]);
  });

  it("returns no matches for unknown queries", () => {
    expect(findWindowsByQuery("missing", sampleWindows)).toEqual([]);
    expect(resolveWindowMatch("missing", sampleWindows)).toBeNull();
  });
});

describe("window alias exports", () => {
  it("keeps the exported aliases wired to the canonical functions", () => {
    expect(list_windows).toBe(listWindows);
    expect(switch_to_window).toBe(switchWindow);
    expect(arrange_windows).toBe(arrangeWindows);
    expect(move_window).toBe(moveWindow);
    expect(restore_window).toBe(restoreWindow);
    expect(focus_window).toBe(focusWindow);
  });
});
