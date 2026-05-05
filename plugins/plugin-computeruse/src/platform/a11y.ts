/**
 * Cross-platform accessibility tree extraction.
 *
 * OSWorld benchmarks expect an optional accessibility tree as part of the
 * observation. This module extracts a simplified a11y tree from the desktop
 * using native platform tools.
 *
 * macOS  — System Accessibility API via osascript / swift
 * Linux  — AT-SPI via python3-atspi or qdbus
 * Windows — UIAutomation via PowerShell
 */

import { execSync } from "node:child_process";
import { commandExists, currentPlatform } from "./helpers.js";

export interface A11yNode {
  role: string;
  name: string;
  description?: string;
  value?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: A11yNode[];
}

/**
 * Extract the accessibility tree of the focused window / screen.
 * Returns a simplified plain-text accessibility tree suitable for LLM consumption.
 *
 * Returns null if a11y data is unavailable on the current platform.
 */
export function extractA11yTree(): string | null {
  const os = currentPlatform();

  try {
    if (os === "darwin") {
      return extractA11yDarwin();
    }
    if (os === "linux") {
      return extractA11yLinux();
    }
    if (os === "win32") {
      return extractA11yWindows();
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Check if a11y tree extraction is available on this platform.
 */
export function isA11yAvailable(): boolean {
  const os = currentPlatform();

  if (os === "darwin") {
    // AppleScript System Events always available (may need accessibility permission)
    return true;
  }
  if (os === "linux") {
    return commandExists("python3") || commandExists("gdbus");
  }
  if (os === "win32") {
    // PowerShell UIAutomation always available on modern Windows
    return true;
  }
  return false;
}

// ── macOS ───────────────────────────────────────────────────────────────

function extractA11yDarwin(): string | null {
  try {
    // Get focused application's UI elements via AppleScript
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set resultText to "Application: " & appName & return
        try
          set frontWin to window 1 of frontApp
          set winTitle to name of frontWin
          set resultText to resultText & "Window: " & winTitle & return
          set uiElements to entire contents of frontWin
          repeat with elem in uiElements
            try
              set elemRole to role of elem
              set elemName to ""
              try
                set elemName to name of elem
              end try
              set elemDesc to ""
              try
                set elemDesc to description of elem
              end try
              set elemValue to ""
              try
                set elemValue to value of elem as text
              end try
              if elemName is not "" or elemDesc is not "" then
                set resultText to resultText & "[" & elemRole & "] " & elemName
                if elemDesc is not "" then
                  set resultText to resultText & " (" & elemDesc & ")"
                end if
                if elemValue is not "" and (length of elemValue) < 100 then
                  set resultText to resultText & " = " & elemValue
                end if
                set resultText to resultText & return
              end if
            end try
          end repeat
        end try
        return resultText
      end tell`;

    const output = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output.trim() || null;
  } catch {
    return null;
  }
}

// ── Linux ───────────────────────────────────────────────────────────────

function extractA11yLinux(): string | null {
  // Try AT-SPI2 via python3
  if (commandExists("python3")) {
    try {
      const pyScript = `
import subprocess, json
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    desktop = Atspi.get_desktop(0)
    lines = []
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app:
            name = app.get_name() or "unknown"
            role = app.get_role_name() or "unknown"
            lines.append(f"[{role}] {name}")
            for j in range(min(app.get_child_count(), 20)):
                child = app.get_child_at_index(j)
                if child:
                    cname = child.get_name() or ""
                    crole = child.get_role_name() or ""
                    lines.append(f"  [{crole}] {cname}")
    print("\\n".join(lines[:200]))
except Exception as e:
    print(f"AT-SPI unavailable: {e}")
`;
      const output = execSync(
        `python3 -c '${pyScript.replace(/'/g, "'\\''")}'`,
        {
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  return null;
}

// ── Windows ─────────────────────────────────────────────────────────────

function extractA11yWindows(): string | null {
  try {
    const psScript = `
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = [System.Windows.Automation.Condition]::TrueCondition
$walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
$lines = @()
$lines += "Focused: $($focused.Current.Name) [$($focused.Current.ControlType.ProgrammaticName)]"
$parent = $walker.GetParent($focused)
if ($parent) {
    $lines += "Parent: $($parent.Current.Name) [$($parent.Current.ControlType.ProgrammaticName)]"
    $child = $walker.GetFirstChild($parent)
    $count = 0
    while ($child -and $count -lt 50) {
        $lines += "  [$($child.Current.ControlType.ProgrammaticName)] $($child.Current.Name)"
        $child = $walker.GetNextSibling($child)
        $count++
    }
}
$lines -join [Environment]::NewLine
`;
    const output = execSync(
      `powershell -Command "${psScript.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return output.trim() || null;
  } catch {
    return null;
  }
}
