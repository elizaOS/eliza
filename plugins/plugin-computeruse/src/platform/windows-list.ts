/**
 * Cross-platform window listing and management.
 *
 * Ported from:
 * - coasty-ai/open-computer-use local-executor.ts window handlers (Apache 2.0)
 * - eliza sandbox-routes.ts listWindows()
 */

import { execFileSync, execSync } from "node:child_process";
import type { ScreenRegion, ScreenSize, WindowInfo } from "../types.js";
import {
  commandExists,
  currentPlatform,
  runCommand,
  validateInt,
  validateWindowId,
} from "./helpers.js";

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeWindowQuery(value: string): string {
  return value.trim().toLowerCase();
}

function matchesWindowQuery(win: WindowInfo, query: string): boolean {
  const normalized = normalizeWindowQuery(query);
  if (!normalized) return false;

  return [win.id, win.title, win.app].some((field) =>
    normalizeWindowQuery(field).includes(normalized),
  );
}

export function findWindowsByQuery(
  query: string,
  windows: WindowInfo[] = listWindows(),
): WindowInfo[] {
  const normalized = normalizeWindowQuery(query);
  if (!normalized) return [];

  const exact = windows.filter(
    (win) => normalizeWindowQuery(win.id) === normalized,
  );
  if (exact.length > 0) return exact;

  return windows.filter((win) => matchesWindowQuery(win, normalized));
}

function resolveWindowTarget(queryOrId: string): WindowInfo | null {
  const matches = findWindowsByQuery(queryOrId);
  return matches[0] ?? null;
}

function resolveWindowTargetOrThrow(queryOrId: string): WindowInfo {
  const target = resolveWindowTarget(queryOrId);
  if (!target) {
    throw new Error(`Window not found: ${queryOrId}`);
  }
  return target;
}

function resolveWindowCommandId(queryOrId: string): string {
  const target = resolveWindowTarget(queryOrId);
  return validateWindowId(target?.id ?? queryOrId);
}

export function resolveWindowMatch(
  queryOrId: string,
  windows: WindowInfo[] = listWindows(),
): WindowInfo | null {
  return findWindowsByQuery(queryOrId, windows)[0] ?? null;
}

function appleScriptWindowMatchTerms(target: WindowInfo): string[] {
  return [target.id, target.title, target.app]
    .map((value) => normalizeWindowQuery(value))
    .filter((value) => value.length > 0 && value !== "unknown");
}

function runDarwinWindowScript(target: WindowInfo, body: string): string {
  const terms = appleScriptWindowMatchTerms(target);
  const termList =
    terms.length > 0
      ? `{${terms.map((term) => `"${escapeAppleScriptString(term)}"`).join(", ")}}`
      : "{}";
  // Two-pass match: first by process name (fast — no accessibility-tree walk),
  // then by window title only if no process matched. The previous single pass
  // walked `every window of` every non-matching process via System Events,
  // which on a busy desktop blew past the osascript timeout and surfaced as a
  // bogus "Accessibility denied" error (the timeout message matches the
  // accessibility classifier). Window operations are process-level
  // (`window 1 of proc`), so a process match is sufficient to act.
  const script = `
      tell application "System Events"
        set matchedProc to missing value
        repeat with proc in (every process whose visible is true)
          try
            set procName to name of proc
            repeat with term in ${termList}
              if procName contains term then
                set matchedProc to contents of proc
                exit repeat
              end if
            end repeat
          end try
          if matchedProc is not missing value then exit repeat
        end repeat
        if matchedProc is missing value then
          repeat with proc in (every process whose visible is true)
            try
              repeat with w in (every window of proc)
                repeat with term in ${termList}
                  if (name of w) contains term then
                    set matchedProc to contents of proc
                    exit repeat
                  end if
                end repeat
                if matchedProc is not missing value then exit repeat
              end repeat
            end try
            if matchedProc is not missing value then exit repeat
          end repeat
        end if
        if matchedProc is not missing value then
          set proc to matchedProc
          ${body}
        end if
      end tell`;

  return runCommand("osascript", ["-e", script], 15000);
}

// ── List Windows ────────────────────────────────────────────────────────────

export function listWindows(): WindowInfo[] {
  const os = currentPlatform();

  if (os === "darwin") {
    return listWindowsDarwin();
  }
  if (os === "linux") {
    return listWindowsLinux();
  }
  if (os === "win32") {
    return listWindowsWindows();
  }
  return [];
}

// `owner|||title` (sentinel-joined) → WindowInfo. macOS windows have no stable
// id we can act on (System Events `window` elements expose no `id` — reading it
// throws -1728), and every window operation here is process-level (`window 1 of
// proc`, matched by app/title term), so the owning app name + window title are
// the only usable identifiers. The id is the title when present, else the app.
function parseDarwinWindowEntry(entry: string): WindowInfo | null {
  const [app, title] = entry.split("|||");
  const appName = app?.trim() ?? "";
  const winTitle = title?.trim() ?? "";
  if (!appName && !winTitle) return null;
  return {
    app: appName || "unknown",
    title: winTitle,
    id: winTitle || appName,
  };
}

// Swift CGWindowList enumerator, fed to `swift -` on stdin. Fast (~0.5s incl.
// compile) and only needs Screen Recording (for window titles); falls back to
// the empty owner/title when that permission is absent. Normal app windows are
// layer 0; desktop/menubar elements are excluded.
const DARWIN_WINDOW_LIST_SWIFT = `import CoreGraphics
import Foundation
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(0) }
var out: [String] = []
for w in list {
  if ((w[kCGWindowLayer as String] as? Int) ?? -1) != 0 { continue }
  let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
  let name = (w[kCGWindowName as String] as? String) ?? ""
  out.append(owner + "|||" + name)
}
print(out.joined(separator: "<<WIN>>"))`;

export function parseDarwinWindowOutput(output: string): WindowInfo[] {
  return output
    .split("<<WIN>>")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseDarwinWindowEntry)
    .filter((win): win is WindowInfo => win !== null);
}

// Returns null (not []) when Swift is unavailable or the call fails, so the
// caller can fall back to System Events. An empty-but-successful Swift result is
// a real "no windows" answer and is returned as [].
function listWindowsDarwinViaSwift(): WindowInfo[] | null {
  if (!commandExists("swift")) return null;
  try {
    const output = execFileSync("swift", ["-"], {
      input: DARWIN_WINDOW_LIST_SWIFT,
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return parseDarwinWindowOutput(output);
  } catch {
    return null;
  }
}

// Fallback for macOS hosts without the Swift toolchain. Walks the System Events
// accessibility tree, which is correct but multi-second on a busy desktop —
// hence the generous timeout. Concatenate with a sentinel rather than coercing
// a list via `text item delimiters`, whose canonical `AppleScript's …` form
// embeds an apostrophe that breaks the single-quoted `osascript -e '…'` shell.
function listWindowsDarwinViaSystemEvents(): WindowInfo[] {
  try {
    const script = `
      tell application "System Events"
        set outText to ""
        repeat with proc in (every process whose visible is true)
          set procName to name of proc
          try
            set procName to name of proc
            repeat with w in (every window of proc)
              try
                set outText to outText & procName & "|||" & (name of w) & "<<WIN>>"
              end try
            end repeat
          end try
        end repeat
        return outText
      end tell`;
    const output = execSync(`osascript -e '${script}'`, {
      encoding: "utf-8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseDarwinWindowOutput(output);
  } catch {
    return [];
  }
}

function listWindowsDarwin(): WindowInfo[] {
  return listWindowsDarwinViaSwift() ?? listWindowsDarwinViaSystemEvents();
}

function listWindowsLinux(): WindowInfo[] {
  try {
    if (commandExists("wmctrl")) {
      const output = execSync("wmctrl -l", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          // wmctrl format: 0x0400000a  0 hostname Title
          const parts = line.trim().split(/\s+/);
          const id = parts[0] ?? "0";
          const title = parts.slice(3).join(" ") || "unknown";
          return { id, title, app: "unknown" };
        });
    }
    const output = execSync(
      'xdotool search --name "" getwindowname 2>/dev/null || true',
      { encoding: "utf-8", timeout: 5000 },
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map((line, i) => ({
        id: String(i),
        title: line.trim(),
        app: "unknown",
      }));
  } catch {
    return [];
  }
}

function listWindowsWindows(): WindowInfo[] {
  try {
    const output = execSync(
      `powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object Id, MainWindowTitle | ConvertTo-Json"`,
      { encoding: "utf-8", timeout: 10000 },
    );
    const parsed = JSON.parse(output);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p: { Id: number; MainWindowTitle: string }) => ({
      id: String(p.Id),
      title: p.MainWindowTitle,
      app: "unknown",
    }));
  } catch {
    return [];
  }
}

// ── Focus Window ────────────────────────────────────────────────────────────

/**
 * The currently-focused / frontmost window (#9170 M12 — cua
 * `get_current_window_id`). Best-effort per-OS query; returns `null` when no
 * window is focused or the platform query is unavailable.
 */
export function getActiveWindow(): WindowInfo | null {
  const os = currentPlatform();
  try {
    if (os === "darwin") {
      // System Events windows have no `id` (see listWindowsDarwin); identify the
      // active window by its title scoped to the frontmost process, falling back
      // to the process name so the id is always a usable match term.
      const script = `
        tell application "System Events"
          set proc to first process whose frontmost is true
          set procName to name of proc
          try
            set winName to name of window 1 of proc
            return procName & "|||" & winName & "|||" & winName
          on error
            return procName & "|||" & "" & "|||" & procName
          end try
        end tell`;
      const out = execSync(`osascript -e '${script}'`, {
        encoding: "utf-8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const [app, title, id] = out.split("|||");
      if (!app) return null;
      return { id: id || "0", title: title ?? "", app };
    }
    if (os === "linux") {
      if (!commandExists("xdotool")) return null;
      const id = runCommand("xdotool", ["getactivewindow"], 5000).trim();
      if (!id) return null;
      const title = runCommand("xdotool", ["getwindowname", id], 5000).trim();
      return { id, title, app: title };
    }
    if (os === "win32") {
      const ps =
        "Add-Type 'using System;using System.Runtime.InteropServices;" +
        'public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}\';' +
        "$h=[W]::GetForegroundWindow();" +
        "$p=Get-Process | Where-Object { $_.MainWindowHandle -eq $h } | Select-Object -First 1;" +
        'if($p){ "$($p.Id)|||$($p.MainWindowTitle)|||$($p.ProcessName)" }';
      const out = execSync(
        `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`,
        {
          encoding: "utf-8",
          timeout: 8000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (!out) return null;
      const [id, title, app] = out.split("|||");
      if (!id) return null;
      return { id, title: title ?? "", app: app ?? "" };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Windows belonging to a given application name (#9170 M12 — cua
 * `get_application_windows`). Pure filter over `listWindows()`; case-insensitive
 * substring match on the window's `app` (with a `title` fallback).
 */
export function getApplicationWindows(appName: string): WindowInfo[] {
  const needle = normalizeWindowQuery(appName);
  if (!needle) return [];
  return listWindows().filter(
    (w) =>
      normalizeWindowQuery(w.app).includes(needle) ||
      normalizeWindowQuery(w.title).includes(needle),
  );
}

/**
 * Set a window's position AND size in one call (#9170 M12 — cua set window
 * size+position). Position is required; width/height optional (position-only
 * when omitted).
 */
export function resizeWindow(
  windowId: string,
  x: number,
  y: number,
  width?: number,
  height?: number,
): { success: true; message: string } {
  if (typeof x !== "number" || typeof y !== "number") {
    throw new Error("x and y are required for window set_bounds");
  }
  setWindowBounds(windowId, x, y, width, height);
  const size =
    width !== undefined && height !== undefined
      ? ` size (${validateInt(width)}x${validateInt(height)})`
      : "";
  return {
    success: true,
    message: `Set window to (${validateInt(x)}, ${validateInt(y)})${size}.`,
  };
}

/**
 * Read a window's bounds — position AND size — in OS-global logical pixels
 * (#9170 M12 — cua `get_window_size` / `get_window_position`). When `windowId`
 * is omitted, reads the currently-focused/foreground window. Returns
 * `{ x, y, width, height }`.
 *
 * Windows: `GetWindowRect` via the window's `MainWindowHandle`. macOS: AppleScript
 * `position`/`size` of the matched process window. Linux: `xdotool
 * getwindowgeometry --shell`.
 */
export function getWindowBounds(windowId?: string): ScreenRegion {
  const os = currentPlatform();
  const id = windowId ?? getActiveWindow()?.id;
  if (!id) {
    throw new Error(
      "No windowId provided and no active window to read bounds from",
    );
  }

  if (os === "darwin") {
    const target = resolveWindowTargetOrThrow(id);
    const out = runDarwinWindowScript(
      target,
      `set winPos to position of window 1 of proc
       set winSize to size of window 1 of proc
       return ((item 1 of winPos) as text) & "," & ((item 2 of winPos) as text) & "," & ((item 1 of winSize) as text) & "," & ((item 2 of winSize) as text)`,
    ).trim();
    const [x, y, width, height] = out.split(",").map((v) => Number(v.trim()));
    if ([x, y, width, height].some((n) => !Number.isFinite(n))) {
      throw new Error(`Could not read window bounds for: ${id}`);
    }
    return { x, y, width, height };
  }

  if (os === "linux") {
    if (!commandExists("xdotool")) {
      throw new Error("getWindowBounds requires xdotool on Linux");
    }
    const commandId = resolveWindowCommandId(id);
    const out = runCommand(
      "xdotool",
      ["getwindowgeometry", "--shell", commandId],
      5000,
    );
    const mx = /X=(-?\d+)/.exec(out);
    const my = /Y=(-?\d+)/.exec(out);
    const mw = /WIDTH=(\d+)/.exec(out);
    const mh = /HEIGHT=(\d+)/.exec(out);
    if (!mx || !my || !mw || !mh) {
      throw new Error(`Could not parse xdotool geometry for: ${id}`);
    }
    return {
      x: validateInt(Number(mx[1])),
      y: validateInt(Number(my[1])),
      width: validateInt(Number(mw[1])),
      height: validateInt(Number(mh[1])),
    };
  }

  if (os === "win32") {
    const commandId = resolveWindowCommandId(id);
    // GetWindowRect via the process MainWindowHandle. Uses -MemberDefinition
    // (signed-assembly P/Invoke, NOT a runtime-compiled inline class) to declare
    // the RECT struct + the import together; see desktop.ts / setWindowBounds.
    // NOTE: do NOT pass -UsingNamespace System.Runtime.InteropServices — Add-Type
    // already imports it for the DllImport attribute, and a duplicate using is a
    // warning-as-error that silently fails the type and yields a zeroed rect.
    const ps = `
      Add-Type -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);' -Name Win32Rect -Namespace Win32
      $proc = Get-Process -Id ${commandId} -ErrorAction SilentlyContinue
      if (-not $proc) { throw "Window not found: ${commandId}" }
      $r = New-Object "Win32.Win32Rect+RECT"
      [void][Win32.Win32Rect]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
      "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
    `;
    // 10s: the first Add-Type call JIT-compiles the P/Invoke shim (cold csc),
    // which can exceed the 5s used elsewhere when the box is under load.
    const out = runCommand("powershell", ["-Command", ps], 10000).trim();
    const [left, top, right, bottom] = out.split(",").map((v) => Number(v.trim()));
    if ([left, top, right, bottom].some((n) => !Number.isFinite(n))) {
      throw new Error(`Could not read window bounds for: ${id}`);
    }
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  throw new Error(`getWindowBounds is not supported on ${os}`);
}

export function focusWindow(windowId: string): void {
  const os = currentPlatform();
  const target = resolveWindowTarget(windowId);

  if (os === "darwin") {
    const commandTarget = target ?? resolveWindowTargetOrThrow(windowId);
    try {
      runDarwinWindowScript(commandTarget, "set frontmost of proc to true");
    } catch {
      runCommand(
        "osascript",
        [
          "-e",
          `tell application "${escapeAppleScriptString(commandTarget.app)}" to activate`,
        ],
        5000,
      );
    }
  } else if (os === "linux") {
    const commandId = resolveWindowCommandId(windowId);
    if (commandExists("wmctrl")) {
      runCommand("wmctrl", ["-i", "-a", commandId], 5000);
    } else if (commandExists("xdotool")) {
      runCommand("xdotool", ["windowactivate", commandId], 5000);
    } else {
      throw new Error("Window focus requires wmctrl or xdotool on Linux");
    }
  } else if (os === "win32") {
    const commandId = resolveWindowCommandId(windowId);
    const ps = `
      Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -Name Win32 -Namespace Win32
      $proc = Get-Process -Id ${commandId} -ErrorAction SilentlyContinue
      if (-not $proc) { throw "Window not found: ${commandId}" }
      [Win32.Win32]::SetForegroundWindow($proc.MainWindowHandle)
    `;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

export function switchWindow(windowQuery: string): void {
  focusWindow(windowQuery);
}

function setWindowBounds(
  windowId: string,
  x: number,
  y: number,
  width?: number,
  height?: number,
): void {
  const safeX = validateInt(x);
  const safeY = validateInt(y);
  const safeWidth =
    width === undefined ? undefined : Math.max(1, validateInt(width));
  const safeHeight =
    height === undefined ? undefined : Math.max(1, validateInt(height));
  const os = currentPlatform();

  if (os === "darwin") {
    const target = resolveWindowTargetOrThrow(windowId);
    runDarwinWindowScript(
      target,
      `
              set position of window 1 of proc to {${safeX}, ${safeY}}
              ${
                safeWidth !== undefined && safeHeight !== undefined
                  ? `set size of window 1 of proc to {${safeWidth}, ${safeHeight}}`
                  : ""
              }`,
    );
    return;
  }

  const commandId = resolveWindowCommandId(windowId);
  if (os === "linux") {
    if (commandExists("wmctrl")) {
      runCommand(
        "wmctrl",
        [
          "-i",
          "-r",
          commandId,
          "-e",
          `0,${safeX},${safeY},${safeWidth ?? -1},${safeHeight ?? -1}`,
        ],
        5000,
      );
      return;
    }
    if (commandExists("xdotool")) {
      runCommand(
        "xdotool",
        ["windowmove", commandId, String(safeX), String(safeY)],
        5000,
      );
      if (safeWidth !== undefined && safeHeight !== undefined) {
        runCommand(
          "xdotool",
          ["windowsize", commandId, String(safeWidth), String(safeHeight)],
          5000,
        );
      }
      return;
    }
    throw new Error("Window move requires wmctrl or xdotool on Linux");
  }

  if (os === "win32") {
    const noSizeFlag =
      safeWidth === undefined || safeHeight === undefined ? "0x0001" : "0";
    const widthArg = safeWidth ?? 0;
    const heightArg = safeHeight ?? 0;
    const ps = `
      Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);' -Name Win32 -Namespace Win32
      $proc = Get-Process -Id ${commandId} -ErrorAction SilentlyContinue
      if (-not $proc) { throw "Window not found: ${commandId}" }
      [Win32.Win32]::SetWindowPos($proc.MainWindowHandle, [IntPtr]::Zero, ${safeX}, ${safeY}, ${widthArg}, ${heightArg}, ${noSizeFlag})
    `;
    runCommand("powershell", ["-Command", ps], 5000);
    return;
  }

  throw new Error(`Window move is not supported on ${os}`);
}

export function arrangeWindows(arrangement = "tile"): {
  success: true;
  message: string;
} {
  const windows = listWindows();
  if (windows.length === 0) {
    return {
      success: true,
      message: "No visible windows found to arrange.",
    };
  }

  const screen = getScreenSize();
  const normalized = arrangement.trim().toLowerCase();
  const count = windows.length;
  const cascadeOffset = 32;

  windows.forEach((windowInfo, index) => {
    if (normalized === "cascade") {
      const width = Math.max(480, Math.floor(screen.width * 0.72));
      const height = Math.max(360, Math.floor(screen.height * 0.72));
      const maxOffsetX = Math.max(0, screen.width - width);
      const maxOffsetY = Math.max(0, screen.height - height);
      setWindowBounds(
        windowInfo.id,
        Math.min(index * cascadeOffset, maxOffsetX),
        Math.min(index * cascadeOffset, maxOffsetY),
        width,
        height,
      );
      return;
    }

    if (normalized === "vertical") {
      const width = Math.max(1, Math.floor(screen.width / count));
      setWindowBounds(windowInfo.id, index * width, 0, width, screen.height);
      return;
    }

    if (normalized === "horizontal") {
      const height = Math.max(1, Math.floor(screen.height / count));
      setWindowBounds(windowInfo.id, 0, index * height, screen.width, height);
      return;
    }

    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const width = Math.max(1, Math.floor(screen.width / columns));
    const height = Math.max(1, Math.floor(screen.height / rows));
    const column = index % columns;
    const row = Math.floor(index / columns);
    setWindowBounds(windowInfo.id, column * width, row * height, width, height);
  });

  return {
    success: true,
    message: `Arranged ${windows.length} window${windows.length === 1 ? "" : "s"} using ${normalized || "tile"} layout.`,
  };
}

export function moveWindow(
  windowId: string,
  x?: number,
  y?: number,
): {
  success: true;
  message: string;
} {
  if (typeof x !== "number" || typeof y !== "number") {
    throw new Error("x and y are required for window move");
  }
  setWindowBounds(windowId, x, y);
  return {
    success: true,
    message: `Moved window to (${validateInt(x)}, ${validateInt(y)}).`,
  };
}

// ── Minimize Window ─────────────────────────────────────────────────────────

export function minimizeWindow(windowId: string): void {
  const os = currentPlatform();
  const target = resolveWindowTarget(windowId);

  if (os === "darwin") {
    runDarwinWindowScript(
      target ?? resolveWindowTargetOrThrow(windowId),
      "set miniaturized of window 1 of proc to true",
    );
  } else if (os === "linux") {
    const commandId = resolveWindowCommandId(windowId);
    if (commandExists("xdotool")) {
      runCommand("xdotool", ["windowminimize", commandId], 5000);
    } else {
      throw new Error("Window minimize requires xdotool on Linux");
    }
  } else if (os === "win32") {
    const commandId = resolveWindowCommandId(windowId);
    const ps = `
      Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name Win32 -Namespace Win32
      $proc = Get-Process -Id ${commandId} -ErrorAction SilentlyContinue
      if (-not $proc) { throw "Window not found: ${commandId}" }
      [Win32.Win32]::ShowWindow($proc.MainWindowHandle, 6)
    `;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Maximize Window ─────────────────────────────────────────────────────────

export function maximizeWindow(windowId: string): void {
  const os = currentPlatform();
  const target = resolveWindowTarget(windowId);

  if (os === "darwin") {
    runDarwinWindowScript(
      target ?? resolveWindowTargetOrThrow(windowId),
      'set value of attribute "AXFullScreen" of window 1 of proc to true',
    );
  } else if (os === "linux") {
    const commandId = resolveWindowCommandId(windowId);
    if (commandExists("wmctrl")) {
      runCommand(
        "wmctrl",
        ["-i", "-r", commandId, "-b", "add,maximized_vert,maximized_horz"],
        5000,
      );
    } else {
      throw new Error("Window maximize requires wmctrl on Linux");
    }
  } else if (os === "win32") {
    const commandId = resolveWindowCommandId(windowId);
    const ps = `
      Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name Win32 -Namespace Win32
      $proc = Get-Process -Id ${commandId} -ErrorAction SilentlyContinue
      if (-not $proc) { throw "Window not found: ${commandId}" }
      [Win32.Win32]::ShowWindow($proc.MainWindowHandle, 3)
    `;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

export function restoreWindow(windowId: string): void {
  const os = currentPlatform();
  const target = resolveWindowTarget(windowId);

  if (os === "darwin") {
    runDarwinWindowScript(
      target ?? resolveWindowTargetOrThrow(windowId),
      `
              try
                set miniaturized of window 1 of proc to false
              end try
              set frontmost of proc to true`,
    );
  } else if (os === "linux") {
    const commandId = resolveWindowCommandId(windowId);
    if (commandExists("wmctrl")) {
      runCommand(
        "wmctrl",
        ["-i", "-r", commandId, "-b", "remove,maximized_vert,maximized_horz"],
        5000,
      );
      runCommand("wmctrl", ["-i", "-a", commandId], 5000);
    } else if (commandExists("xdotool")) {
      runCommand("xdotool", ["windowactivate", commandId], 5000);
    } else {
      throw new Error("Window restore requires wmctrl or xdotool on Linux");
    }
  } else if (os === "win32") {
    const commandId = resolveWindowCommandId(windowId);
    const ps = `
      Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name Win32 -Namespace Win32
      $proc = Get-Process -Id ${commandId} -ErrorAction SilentlyContinue
      if (-not $proc) { throw "Window not found: ${commandId}" }
      [Win32.Win32]::ShowWindow($proc.MainWindowHandle, 9)
    `;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Close Window ────────────────────────────────────────────────────────────

export function closeWindow(windowId: string): void {
  const os = currentPlatform();
  const target = resolveWindowTarget(windowId);

  if (os === "darwin") {
    runDarwinWindowScript(
      target ?? resolveWindowTargetOrThrow(windowId),
      "click button 1 of window 1 of proc",
    );
  } else if (os === "linux") {
    const commandId = resolveWindowCommandId(windowId);
    if (commandExists("wmctrl")) {
      runCommand("wmctrl", ["-i", "-c", commandId], 5000);
    } else if (commandExists("xdotool")) {
      runCommand("xdotool", ["windowclose", commandId], 5000);
    } else {
      throw new Error("Window close requires wmctrl or xdotool on Linux");
    }
  } else if (os === "win32") {
    const commandId = resolveWindowCommandId(windowId);
    const ps = `Stop-Process -Id ${commandId} -ErrorAction SilentlyContinue`;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

export const list_windows = listWindows;
export const focus_window = focusWindow;
export const switch_to_window = switchWindow;
export const arrange_windows = arrangeWindows;
export const move_window = moveWindow;
export const minimize_window = minimizeWindow;
export const maximize_window = maximizeWindow;
export const restore_window = restoreWindow;
export const close_window = closeWindow;

// ── Screen Size ─────────────────────────────────────────────────────────────

/**
 * PowerShell command that reads the primary screen bounds on Windows.
 *
 * `Add-Type -AssemblyName System.Windows.Forms` MUST run before
 * `[System.Windows.Forms.Screen]` is referenced — on a clean PowerShell session
 * the type is otherwise unresolved (`TypeNotFound`) and the screen size silently
 * falls back to a hard-coded default. Exported so a cross-platform unit test can
 * guard against the assembly-load regression without spawning PowerShell.
 */
export const WINDOWS_PRIMARY_SCREEN_SIZE_COMMAND =
  'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; ' +
  '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ConvertTo-Json -Compress"';

export function getScreenSize(): ScreenSize {
  const os = currentPlatform();

  if (os === "darwin") {
    try {
      const output = execSync(
        `osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); const bounds = $.CGDisplayBounds($.CGMainDisplayID()); String(Math.round(bounds.size.width)) + "," + String(Math.round(bounds.size.height));'`,
        { encoding: "utf-8", timeout: 3000 },
      );
      const [width, height] = output
        .trim()
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10));
      if (
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0
      ) {
        return { width, height };
      }
    } catch {
      /* fallback */
    }
    try {
      const output = execSync(
        `osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
        { encoding: "utf-8", timeout: 5000 },
      );
      // Returns: "0, 0, 2560, 1440"
      const parts = output
        .trim()
        .split(",")
        .map((p) => Number.parseInt(p.trim(), 10));
      const width = parts[2];
      const height = parts[3];
      if (Number.isFinite(width) && Number.isFinite(height)) {
        return { width, height };
      }
    } catch {
      /* fallback */
    }
    // Fallback: system_profiler
    try {
      const output = execSync(
        "system_profiler SPDisplaysDataType 2>/dev/null | grep Resolution",
        { encoding: "utf-8", timeout: 5000 },
      );
      const match = output.match(/(\d+)\s*x\s*(\d+)/);
      if (match) {
        const [, width, height] = match;
        if (width === undefined || height === undefined) {
          return { width: 1920, height: 1080 };
        }
        return {
          width: Number.parseInt(width, 10),
          height: Number.parseInt(height, 10),
        };
      }
    } catch {
      /* fallback */
    }
    return { width: 1920, height: 1080 };
  }

  if (os === "linux") {
    if (commandExists("xdotool")) {
      try {
        const output = runCommand("xdotool", ["getdisplaygeometry"], 3000);
        const parts = output.trim().split(" ");
        const [width, height] = parts;
        if (width !== undefined && height !== undefined) {
          return {
            width: Number.parseInt(width, 10),
            height: Number.parseInt(height, 10),
          };
        }
      } catch {
        /* fallback */
      }
    }
    if (commandExists("xrandr")) {
      try {
        const output = execSync("xrandr 2>/dev/null | grep '*'", {
          encoding: "utf-8",
          timeout: 5000,
        });
        const match = output.match(/(\d+)x(\d+)/);
        if (match) {
          const [, width, height] = match;
          if (width === undefined || height === undefined) {
            return { width: 1920, height: 1080 };
          }
          return {
            width: Number.parseInt(width, 10),
            height: Number.parseInt(height, 10),
          };
        }
      } catch {
        /* fallback */
      }
    }
    return { width: 1920, height: 1080 };
  }

  if (os === "win32") {
    try {
      const output = execSync(WINDOWS_PRIMARY_SCREEN_SIZE_COMMAND, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const bounds = JSON.parse(output);
      if (
        typeof bounds?.Width === "number" &&
        typeof bounds?.Height === "number" &&
        bounds.Width > 0 &&
        bounds.Height > 0
      ) {
        return { width: bounds.Width, height: bounds.Height };
      }
    } catch {
      /* fallback */
    }
    return { width: 1920, height: 1080 };
  }

  return { width: 1920, height: 1080 };
}
