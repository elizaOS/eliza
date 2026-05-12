/**
 * Cross-platform window listing and management.
 *
 * Ported from:
 * - coasty-ai/open-computer-use local-executor.ts window handlers (Apache 2.0)
 * - eliza sandbox-routes.ts listWindows()
 */

import { execSync } from "node:child_process";
import type { ScreenSize, WindowInfo } from "../types.js";
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

function runDarwinWindowScript(target: WindowInfo, body: string): void {
  const terms = appleScriptWindowMatchTerms(target);
  const termList =
    terms.length > 0
      ? `{${terms.map((term) => `"${escapeAppleScriptString(term)}"`).join(", ")}}`
      : "{}";
  const script = `
      tell application "System Events"
        repeat with proc in (every process whose visible is true)
          try
            set procName to name of proc
            set matched to false
            repeat with term in ${termList}
              if procName contains term then
                set matched to true
                exit repeat
              end if
            end repeat
            if not matched then
              repeat with w in (every window of proc)
                set winName to name of w
                repeat with term in ${termList}
                  if winName contains term then
                    set matched to true
                    exit repeat
                  end if
                end repeat
                if matched then exit repeat
              end repeat
            end if
            if matched then
              ${body}
              exit repeat
            end if
          end try
        end repeat
      end tell`;

  runCommand("osascript", ["-e", script], 5000);
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

function listWindowsDarwin(): WindowInfo[] {
  try {
    const script = `
      tell application "System Events"
        set windowList to {}
        repeat with proc in (every process whose visible is true)
          try
            repeat with w in (every window of proc)
              set end of windowList to (name of proc) & "|||" & (name of w) & "|||" & (id of w as text)
            end repeat
          end try
        end repeat
        return windowList as text
      end tell`;
    const output = execSync(`osascript -e '${script}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(", ")
      .filter(Boolean)
      .map((entry) => {
        const parts = entry.split("|||");
        return {
          app: parts[0] ?? "unknown",
          title: parts[1] ?? "unknown",
          id: parts[2] ?? "0",
        };
      });
  } catch {
    return [];
  }
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
      if (parts.length >= 4) {
        return { width: parts[2]!, height: parts[3]! };
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
        return {
          width: Number.parseInt(match[1]!, 10),
          height: Number.parseInt(match[2]!, 10),
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
        if (parts.length >= 2) {
          return {
            width: Number.parseInt(parts[0]!, 10),
            height: Number.parseInt(parts[1]!, 10),
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
          return {
            width: Number.parseInt(match[1]!, 10),
            height: Number.parseInt(match[2]!, 10),
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
      const output = execSync(
        `powershell -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ConvertTo-Json"`,
        { encoding: "utf-8", timeout: 5000 },
      );
      const bounds = JSON.parse(output);
      return { width: bounds.Width, height: bounds.Height };
    } catch {
      /* fallback */
    }
    return { width: 1920, height: 1080 };
  }

  return { width: 1920, height: 1080 };
}
