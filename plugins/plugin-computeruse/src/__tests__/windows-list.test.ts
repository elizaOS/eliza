/**
 * Unit coverage for the pure window-matching logic (#9170 / #9105).
 *
 * `findWindowsByQuery` / `resolveWindowMatch` resolve an agent-supplied
 * window query (id, title, or app substring) to concrete windows before the
 * per-OS focus/move/arrange handlers act on them — the WINDOW action's
 * targeting core. Only a gated real-driver test exercised this on Windows;
 * these cases pin the exact-id precedence + case-insensitive substring rules
 * deterministically on every OS by passing an explicit window list.
 */

import { describe, expect, it } from "vitest";
import {
  findWindowsByQuery,
  parseDarwinWindowOutput,
  resolveWindowMatch,
} from "../platform/windows-list.js";
import type { WindowInfo } from "../types.js";

const wins: WindowInfo[] = [
  { id: "0x1a", title: "Notepad — untitled", app: "Notepad" },
  { id: "0x2b", title: "Project — Visual Studio Code", app: "Code" },
  { id: "42", title: "Calculator", app: "Calc" },
  { id: "100", title: "Window 42 backup", app: "Backup" },
];

describe("findWindowsByQuery", () => {
  it("returns nothing for an empty / whitespace query", () => {
    expect(findWindowsByQuery("", wins)).toEqual([]);
    expect(findWindowsByQuery("   ", wins)).toEqual([]);
  });

  it("matches an exact window id case-insensitively", () => {
    expect(findWindowsByQuery("0X1A", wins).map((w) => w.id)).toEqual(["0x1a"]);
  });

  it("prefers an exact id over a substring match (no bleed-through)", () => {
    // id "42" is an exact id match; "Window 42 backup" (id 100) only matches as
    // a title substring and must NOT be returned alongside the exact id.
    expect(findWindowsByQuery("42", wins).map((w) => w.id)).toEqual(["42"]);
  });

  it("falls back to a case-insensitive substring match on title and app", () => {
    expect(findWindowsByQuery("visual studio", wins).map((w) => w.id)).toEqual([
      "0x2b",
    ]);
    expect(findWindowsByQuery("NOTEPAD", wins).map((w) => w.id)).toEqual([
      "0x1a",
    ]);
    // matches on the `app` field, not just the title.
    expect(findWindowsByQuery("backup", wins).map((w) => w.id)).toEqual([
      "100",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(findWindowsByQuery("nonexistent-xyz", wins)).toEqual([]);
  });
});

describe("resolveWindowMatch", () => {
  it("returns the first match", () => {
    expect(resolveWindowMatch("calculator", wins)?.id).toBe("42");
  });

  it("returns null for no match or an empty query", () => {
    expect(resolveWindowMatch("nope-xyz", wins)).toBeNull();
    expect(resolveWindowMatch("", wins)).toBeNull();
  });
});

describe("parseDarwinWindowOutput", () => {
  // Regression guard for the macOS window-listing bug: System Events `window`
  // elements have no `id`, so the old `(id of w as text)` script threw for every
  // window and listWindowsDarwin always returned []. The owner|||title parse now
  // uses the window title as the id (the only usable match term), falling back
  // to the app name when the title is empty.
  it("parses sentinel-joined owner|||title entries into WindowInfo", () => {
    const out =
      "Google Chrome|||Issue #9581 - elizaOS<<WIN>>Terminal|||eliza — tmux<<WIN>>";
    expect(parseDarwinWindowOutput(out)).toEqual([
      {
        app: "Google Chrome",
        title: "Issue #9581 - elizaOS",
        id: "Issue #9581 - elizaOS",
      },
      { app: "Terminal", title: "eliza — tmux", id: "eliza — tmux" },
    ]);
  });

  it("uses the app name as the id when a window has no title", () => {
    expect(parseDarwinWindowOutput("Finder|||<<WIN>>")).toEqual([
      { app: "Finder", title: "", id: "Finder" },
    ]);
  });

  it("drops blank entries and trailing separators", () => {
    expect(parseDarwinWindowOutput("")).toEqual([]);
    expect(parseDarwinWindowOutput("<<WIN>><<WIN>>")).toEqual([]);
    expect(parseDarwinWindowOutput("|||<<WIN>>")).toEqual([]);
  });
});
