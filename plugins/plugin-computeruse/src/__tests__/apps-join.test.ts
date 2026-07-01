/**
 * Unit coverage for joinAppsAndWindows on Windows (#9170 / #9105 scene model).
 *
 * SceneBuilder joins the process list and the window list into a per-app
 * `SceneApp[]`. On Windows the join key is the window id (which IS the owning
 * pid). The linux path shells out to wmctrl, so this is win32-gated — and it
 * therefore runs on this Windows box, validating the pure win32 join. Untested
 * until now.
 */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { joinAppsAndWindows } from "../scene/apps.js";
import type { WindowInfo } from "../types.js";

const IS_WIN = platform() === "win32";

const procs = [
  { pid: 100, name: "Notepad" },
  { pid: 200, name: "Code" },
  { pid: 300, name: "Idle" },
];
const windows: WindowInfo[] = [
  { id: "100", title: "untitled", app: "Notepad" },
  { id: "200", title: "project", app: "Code" },
  { id: "999", title: "Orphan", app: "Ghost" },
];

describe.skipIf(!IS_WIN)("joinAppsAndWindows (win32)", () => {
  it("joins each window to its owning process by pid (win.id === pid)", () => {
    const apps = joinAppsAndWindows(procs, windows, "win32");
    const byPid = new Map(apps.map((a) => [a.pid, a]));
    expect(byPid.get(100)?.windows.map((w) => w.id)).toEqual(["100"]);
    expect(byPid.get(100)?.windows[0].title).toBe("untitled");
    expect(byPid.get(200)?.windows.map((w) => w.id)).toEqual(["200"]);
  });

  it("keeps a process that owns no windows", () => {
    const apps = joinAppsAndWindows(procs, windows, "win32");
    expect(apps.find((a) => a.pid === 300)?.windows).toEqual([]);
  });

  it("creates an app bucket for a window whose pid has no process", () => {
    const apps = joinAppsAndWindows(procs, windows, "win32");
    const ghost = apps.find((a) => a.pid === 999);
    expect(ghost?.name).toBe("Ghost");
    expect(ghost?.windows.map((w) => w.id)).toEqual(["999"]);
  });

  it("returns exactly one bucket per distinct pid", () => {
    expect(joinAppsAndWindows(procs, windows, "win32")).toHaveLength(4);
  });
});
