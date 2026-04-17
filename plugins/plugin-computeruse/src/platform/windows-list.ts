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
  escapeAppleScript,
  runCommand,
  validateWindowId,
} from "./helpers.js";

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
  const safeId = validateWindowId(windowId);
  const os = currentPlatform();

  if (os === "darwin") {
    // Use AppleScript to bring window to front by process id
    const script = `
      tell application "System Events"
        set frontmost of (first process whose id is ${safeId}) to true
      end tell`;
    runCommand("osascript", ["-e", script], 5000);
  } else if (os === "linux") {
    if (commandExists("wmctrl")) {
      runCommand("wmctrl", ["-i", "-a", safeId], 5000);
    } else if (commandExists("xdotool")) {
      runCommand("xdotool", ["windowactivate", safeId], 5000);
    }
  } else if (os === "win32") {
    const ps = `
      Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -Name Win32 -Namespace Win32
      $proc = Get-Process -Id ${safeId} -ErrorAction SilentlyContinue
      if ($proc) { [Win32.Win32]::SetForegroundWindow($proc.MainWindowHandle) }
    `;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

function isWindowId(target: string): boolean {
  return /^[0-9]+$/.test(target) || /^0x[0-9a-f]+$/i.test(target);
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function switchWindow(target: string): void {
  const os = currentPlatform();
  const trimmed = target.trim();
  const byId = isWindowId(trimmed);

  if (os === "darwin") {
    const script = byId
      ? [
          'tell application "System Events"',
          `set frontmost of (first process whose unix id is ${trimmed}) to true`,
          "end tell",
        ].join("\n")
      : [
          `set targetName to ${escapeAppleScript(trimmed)}`,
          'tell application "System Events"',
          "set targetProcess to first process whose visible is true and (name contains targetName or exists (first window whose name contains targetName))",
          "set frontmost of targetProcess to true",
          "end tell",
        ].join("\n");
    runCommand("osascript", ["-e", script], 5000);
    return;
  }

  if (os === "linux") {
    if (commandExists("wmctrl")) {
      const args = byId ? ["-i", "-a", trimmed] : ["-a", trimmed];
      runCommand("wmctrl", args, 5000);
      return;
    }
    if (commandExists("xdotool")) {
      const args = byId
        ? ["windowactivate", trimmed]
        : ["search", "--name", trimmed, "windowactivate"];
      runCommand("xdotool", args, 5000);
      return;
    }
    throw new Error("No supported window activation tool available");
  }

  if (os === "win32") {
    const ps = byId
      ? [
          "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -Name Win32 -Namespace Win32",
          `$proc = Get-Process -Id ${trimmed} -ErrorAction SilentlyContinue`,
          "if (-not $proc) { throw 'Window not found' }",
          "[Win32.Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null",
        ].join("; ")
      : [
          "Add-Type -AssemblyName Microsoft.VisualBasic",
          `$target = '${escapePowerShellSingleQuoted(trimmed)}'`,
          '$proc = Get-Process | Where-Object { $_.MainWindowTitle -like ("*" + $target + "*") } | Select-Object -First 1',
          "if (-not $proc) { throw 'Window not found' }",
          "[Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) | Out-Null",
        ].join("; ");
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Minimize Window ─────────────────────────────────────────────────────────

export function minimizeWindow(windowId: string): void {
  const safeId = validateWindowId(windowId);
  const os = currentPlatform();

  if (os === "darwin") {
    const script = `tell application "System Events" to set miniaturized of window 1 of (first process whose id is ${safeId}) to true`;
    try {
      runCommand("osascript", ["-e", script], 5000);
    } catch { /* ignore */ }
  } else if (os === "linux") {
    if (commandExists("xdotool")) {
      runCommand("xdotool", ["windowminimize", safeId], 5000);
    }
  } else if (os === "win32") {
    const ps = `
      Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name Win32 -Namespace Win32
      $proc = Get-Process -Id ${safeId} -ErrorAction SilentlyContinue
      if ($proc) { [Win32.Win32]::ShowWindow($proc.MainWindowHandle, 6) }
    `;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Maximize Window ─────────────────────────────────────────────────────────

export function maximizeWindow(windowId: string): void {
  const safeId = validateWindowId(windowId);
  const os = currentPlatform();

  if (os === "darwin") {
    const script = `
      tell application "System Events"
        tell (first process whose id is ${safeId})
          set value of attribute "AXFullScreen" of window 1 to true
        end tell
      end tell`;
    try {
      runCommand("osascript", ["-e", script], 5000);
    } catch { /* ignore */ }
  } else if (os === "linux") {
    if (commandExists("wmctrl")) {
      runCommand("wmctrl", ["-i", "-r", safeId, "-b", "add,maximized_vert,maximized_horz"], 5000);
    }
  } else if (os === "win32") {
    const ps = `
      Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name Win32 -Namespace Win32
      $proc = Get-Process -Id ${safeId} -ErrorAction SilentlyContinue
      if ($proc) { [Win32.Win32]::ShowWindow($proc.MainWindowHandle, 3) }
    `;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

export function restoreWindow(target: string): void {
  const os = currentPlatform();
  const trimmed = target.trim();
  const byId = isWindowId(trimmed);

  if (os === "darwin") {
    const script = byId
      ? [
          'tell application "System Events"',
          `tell (first process whose unix id is ${trimmed})`,
          "set miniaturized of window 1 to false",
          "set frontmost to true",
          "end tell",
          "end tell",
        ].join("\n")
      : [
          `set targetName to ${escapeAppleScript(trimmed)}`,
          'tell application "System Events"',
          "tell (first process whose visible is true and (name contains targetName or exists (first window whose name contains targetName)))",
          "set miniaturized of window 1 to false",
          "set frontmost to true",
          "end tell",
          "end tell",
        ].join("\n");
    runCommand("osascript", ["-e", script], 5000);
    return;
  }

  if (os === "linux") {
    if (commandExists("wmctrl")) {
      if (byId) {
        runCommand("wmctrl", ["-i", "-r", trimmed, "-b", "remove,hidden"], 5000);
        runCommand("wmctrl", ["-i", "-a", trimmed], 5000);
      } else {
        runCommand("wmctrl", ["-r", trimmed, "-b", "remove,hidden"], 5000);
        runCommand("wmctrl", ["-a", trimmed], 5000);
      }
      return;
    }
    if (commandExists("xdotool")) {
      const args = byId
        ? ["windowmap", trimmed, "windowactivate", trimmed]
        : ["search", "--name", trimmed, "windowmap", "%@", "windowactivate", "%@"];
      runCommand("xdotool", args, 5000);
      return;
    }
    throw new Error("No supported window restore tool available");
  }

  if (os === "win32") {
    const ps = byId
      ? [
          "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -Name Win32 -Namespace Win32",
          `$proc = Get-Process -Id ${trimmed} -ErrorAction SilentlyContinue`,
          "if (-not $proc) { throw 'Window not found' }",
          "[Win32.Win32]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null",
          "[Win32.Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null",
        ].join("; ")
      : [
          "Add-Type -AssemblyName Microsoft.VisualBasic",
          `$target = '${escapePowerShellSingleQuoted(trimmed)}'`,
          '$proc = Get-Process | Where-Object { $_.MainWindowTitle -like ("*" + $target + "*") } | Select-Object -First 1',
          "if (-not $proc) { throw 'Window not found' }",
          "[Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) | Out-Null",
        ].join("; ");
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Close Window ────────────────────────────────────────────────────────────

export function closeWindow(windowId: string): void {
  const safeId = validateWindowId(windowId);
  const os = currentPlatform();

  if (os === "darwin") {
    const script = `
      tell application "System Events"
        tell (first process whose id is ${safeId})
          click button 1 of window 1
        end tell
      end tell`;
    try {
      runCommand("osascript", ["-e", script], 5000);
    } catch { /* ignore */ }
  } else if (os === "linux") {
    if (commandExists("wmctrl")) {
      runCommand("wmctrl", ["-i", "-c", safeId], 5000);
    } else if (commandExists("xdotool")) {
      runCommand("xdotool", ["windowclose", safeId], 5000);
    }
  } else if (os === "win32") {
    const ps = `Stop-Process -Id ${safeId} -ErrorAction SilentlyContinue`;
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Screen Size ─────────────────────────────────────────────────────────────

export function getScreenSize(): ScreenSize {
  const os = currentPlatform();

  if (os === "darwin") {
    try {
      const output = execSync(
        `osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
        { encoding: "utf-8", timeout: 5000 },
      );
      // Returns: "0, 0, 2560, 1440"
      const parts = output.trim().split(",").map((p) => Number.parseInt(p.trim(), 10));
      if (parts.length >= 4) {
        return { width: parts[2]!, height: parts[3]! };
      }
    } catch { /* fallback */ }
    // Fallback: system_profiler
    try {
      const output = execSync(
        "system_profiler SPDisplaysDataType 2>/dev/null | grep Resolution",
        { encoding: "utf-8", timeout: 5000 },
      );
      const match = output.match(/(\d+)\s*x\s*(\d+)/);
      if (match) {
        return { width: Number.parseInt(match[1]!, 10), height: Number.parseInt(match[2]!, 10) };
      }
    } catch { /* fallback */ }
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
      } catch { /* fallback */ }
    }
    if (commandExists("xrandr")) {
      try {
        const output = execSync("xrandr 2>/dev/null | grep '*'", {
          encoding: "utf-8",
          timeout: 5000,
        });
        const match = output.match(/(\d+)x(\d+)/);
        if (match) {
          return { width: Number.parseInt(match[1]!, 10), height: Number.parseInt(match[2]!, 10) };
        }
      } catch { /* fallback */ }
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
    } catch { /* fallback */ }
    return { width: 1920, height: 1080 };
  }

  return { width: 1920, height: 1080 };
}
