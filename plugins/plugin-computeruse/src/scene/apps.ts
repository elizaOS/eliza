/**
 * App enumeration — join `listProcesses()` with `listWindows()` to produce
 * a per-pid `SceneApp[]` shape with embedded windows.
 *
 * This is intentionally a join over what we already have. The existing
 * `windows-list.ts` doesn't surface pid on every OS:
 *   - Windows: `Get-Process` already keys by pid; `MainWindowTitle` lives on
 *              the same row. The join is implicit.
 *   - Linux  : `wmctrl -l -p` gives pid per window. We re-invoke wmctrl with
 *              `-p` here when available; otherwise the per-pid map carries an
 *              empty `windows` list.
 *   - macOS  : AppleScript gives `name of proc` but not the pid. We do a
 *              name-based join on `comm`. Close enough for "click in Safari"
 *              — the planner has app-name + window-title to disambiguate.
 *
 * Edge cases:
 *   - A process with no visible windows still appears in `apps[]` with an
 *     empty `windows` list. The planner uses this to know "Slack is running
 *     but minimized" without firing an extra query.
 *   - A window with no resolvable pid (Linux X11 without `_NET_WM_PID`) maps
 *     to a synthetic `{ pid: 0, name: <appField> }` bucket.
 */

import { execFileSync } from "node:child_process";
import { commandExists, currentPlatform } from "../platform/helpers.js";
import { listProcesses } from "../platform/process-list.js";
import { listWindows } from "../platform/windows-list.js";
import type { WindowInfo } from "../types.js";
import type { SceneApp, SceneAppWindow } from "./scene-types.js";

export interface AppEnumerationDeps {
  /** Override for tests. */
  processes?: typeof listProcesses;
  windows?: typeof listWindows;
}

export function enumerateApps(deps: AppEnumerationDeps = {}): SceneApp[] {
  const processFn = deps.processes ?? listProcesses;
  const windowsFn = deps.windows ?? listWindows;
  const procs = processFn();
  const wins = windowsFn();
  return joinAppsAndWindows(procs, wins, currentPlatform());
}

interface RawProc {
  pid: number;
  name: string;
}

interface WindowPidJoin {
  win: WindowInfo;
  pid: number | null;
  bounds: [number, number, number, number];
  displayId: number;
}

export function joinAppsAndWindows(
  procs: RawProc[],
  windows: WindowInfo[],
  platform: "linux" | "darwin" | "win32" | string,
): SceneApp[] {
  const linuxPidMap =
    platform === "linux" && commandExists("wmctrl")
      ? linuxPidMapFromWmctrl()
      : new Map<string, number>();

  const joined: WindowPidJoin[] = windows.map((win) => {
    let pid: number | null = null;
    if (platform === "win32") {
      pid = Number.parseInt(win.id, 10);
      if (!Number.isFinite(pid)) pid = null;
    } else if (platform === "linux") {
      pid = linuxPidMap.get(win.id) ?? null;
    } else if (platform === "darwin") {
      // We don't have pid on the darwin window list; resolve later by
      // name during the buckets pass.
      pid = null;
    }
    return {
      win,
      pid,
      bounds: [0, 0, 0, 0],
      displayId: 0,
    };
  });

  // Build buckets keyed by pid (preferred) or appName (fallback for darwin).
  const buckets = new Map<string, SceneApp>();
  for (const proc of procs) {
    if (!buckets.has(`pid:${proc.pid}`)) {
      buckets.set(`pid:${proc.pid}`, {
        name: proc.name,
        pid: proc.pid,
        windows: [],
      });
    }
  }
  // Index by lower-case name for darwin name-based join.
  const nameIndex = new Map<string, RawProc>();
  for (const proc of procs) {
    const key = proc.name.toLowerCase();
    if (!nameIndex.has(key)) nameIndex.set(key, proc);
  }

  for (const j of joined) {
    let bucket: SceneApp | undefined;
    if (j.pid !== null && j.pid > 0) {
      bucket = buckets.get(`pid:${j.pid}`);
      if (!bucket) {
        bucket = {
          name:
            j.win.app && j.win.app !== "unknown" ? j.win.app : `pid-${j.pid}`,
          pid: j.pid,
          windows: [],
        };
        buckets.set(`pid:${j.pid}`, bucket);
      }
    } else if (platform === "darwin") {
      const proc = nameIndex.get(j.win.app.toLowerCase());
      if (proc) {
        bucket = buckets.get(`pid:${proc.pid}`);
      }
      if (!bucket) {
        const fallback = `app:${j.win.app}`;
        bucket = buckets.get(fallback);
        if (!bucket) {
          bucket = { name: j.win.app, pid: 0, windows: [] };
          buckets.set(fallback, bucket);
        }
      }
    } else {
      const fallback = `app:${j.win.app}`;
      bucket = buckets.get(fallback);
      if (!bucket) {
        bucket = {
          name: j.win.app && j.win.app !== "unknown" ? j.win.app : "unknown",
          pid: 0,
          windows: [],
        };
        buckets.set(fallback, bucket);
      }
    }
    const sceneWin: SceneAppWindow = {
      id: j.win.id,
      title: j.win.title,
      bounds: j.bounds,
      displayId: j.displayId,
    };
    bucket.windows.push(sceneWin);
  }

  return [...buckets.values()];
}

function linuxPidMapFromWmctrl(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const text = execFileSync("wmctrl", ["-l", "-p"], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of text.split(/\r?\n/)) {
      // Format: 0x0400000a  0 12345 hostname Title
      const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s+/);
      if (!m) continue;
      const pid = Number.parseInt(m[2] ?? "0", 10);
      if (Number.isFinite(pid) && pid > 0) {
        out.set(m[1] ?? "", pid);
      }
    }
  } catch {
    /* best effort */
  }
  return out;
}
