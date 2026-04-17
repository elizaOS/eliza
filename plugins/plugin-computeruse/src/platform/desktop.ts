/**
 * Cross-platform desktop automation — mouse, keyboard, scroll, drag.
 *
 * Ported from coasty-ai/open-computer-use desktop-automation.ts (Apache 2.0)
 * and eliza sandbox-routes.ts performClick/performType/performKeypress.
 *
 * Platform backends:
 *   macOS  — cliclick (preferred, brew install cliclick) or AppleScript fallback
 *   Linux  — xdotool (required: sudo apt install xdotool)
 *   Windows — PowerShell with user32.dll P/Invoke
 *
 * All coordinate inputs are validated via validateInt() to prevent injection.
 */

import {
  canonicalKeyName,
  commandExists,
  currentPlatform,
  escapeAppleScript,
  runCommand,
  safeXdotoolKey,
  toCliclickKeyName,
  toWindowsSendKey,
  toXdotoolKeyName,
  validateInt,
  validateKeypress,
  validateText,
} from "./helpers.js";

function toAppleScriptModifier(key: string): string {
  const normalized = key.trim().toLowerCase();
  const mapping: Record<string, string> = {
    cmd: "command",
    command: "command",
    meta: "command",
    super: "command",
    ctrl: "control",
    control: "control",
    alt: "option",
    option: "option",
    shift: "shift",
    fn: "function",
  };
  const modifier = mapping[normalized];
  if (!modifier) {
    throw new Error(`Unsupported modifier key: "${key}"`);
  }
  return modifier;
}

// ── Mouse Click ─────────────────────────────────────────────────────────────

export function desktopClick(x: number, y: number): void {
  const sx = validateInt(x);
  const sy = validateInt(y);
  const os = currentPlatform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`c:${sx},${sy}`], 5000);
    } else {
      runCommand(
        "osascript",
        ["-e", `tell application "System Events" to click at {${sx}, ${sy}}`],
        5000,
      );
    }
  } else if (os === "linux") {
    requireXdotool();
    runCommand("xdotool", ["mousemove", String(sx), String(sy), "click", "1"], 5000);
  } else if (os === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
      "[Win32.Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)",
    ].join("; ");
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

export function desktopClickWithModifiers(
  x: number,
  y: number,
  modifiers: string[],
  button: "left" | "middle" | "right" = "left",
  clicks = 1,
): void {
  const sx = validateInt(x);
  const sy = validateInt(y);
  const safeClicks = Math.max(1, Math.min(validateInt(clicks), 5));
  const os = currentPlatform();
  const normalizedModifiers = modifiers.map((modifier) =>
    validateKeypress(modifier),
  );

  if (os === "darwin") {
    const modifierLines = normalizedModifiers.flatMap((modifier) => {
      const appleModifier = toAppleScriptModifier(modifier);
      return [`key down ${appleModifier}`];
    });
    const releaseLines = [...normalizedModifiers]
      .reverse()
      .map((modifier) => `key up ${toAppleScriptModifier(modifier)}`);
    const clickLine =
      button === "right"
        ? `key down control\nrepeat ${safeClicks} times\nclick at {${sx}, ${sy}}\nend repeat\nkey up control`
        : `repeat ${safeClicks} times\nclick at {${sx}, ${sy}}\nend repeat`;
    runCommand(
      "osascript",
      [
        "-e",
        [
          'tell application "System Events"',
          ...modifierLines,
          clickLine,
          ...releaseLines,
          "end tell",
        ].join("\n"),
      ],
      5000,
    );
    return;
  }

  if (os === "linux") {
    requireXdotool();
    const args = [
      ...normalizedModifiers.flatMap((modifier) => [
        "keydown",
        safeXdotoolKey(modifier),
      ]),
      "mousemove",
      String(sx),
      String(sy),
      "click",
      "--repeat",
      String(safeClicks),
      button === "right" ? "3" : button === "middle" ? "2" : "1",
      ...[...normalizedModifiers].reverse().flatMap((modifier) => [
        "keyup",
        safeXdotoolKey(modifier),
      ]),
    ];
    runCommand("xdotool", args, 7000);
    return;
  }

  if (os === "win32") {
    const vkCodes: Record<string, number> = {
      shift: 0x10,
      ctrl: 0x11,
      control: 0x11,
      alt: 0x12,
      option: 0x12,
      cmd: 0x5b,
      command: 0x5b,
      meta: 0x5b,
      super: 0x5b,
    };
    const downFlags = button === "right" ? "0x0008" : "0x0002";
    const upFlags = button === "right" ? "0x0010" : "0x0004";
    const lines = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo); [DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Input -Namespace Win32`,
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
      ...normalizedModifiers.map((modifier) => {
        const vk = vkCodes[modifier.trim().toLowerCase()];
        if (!vk) {
          throw new Error(`Unsupported modifier key: "${modifier}"`);
        }
        return `[Win32.Win32Input]::keybd_event(${vk}, 0, 0, 0)`;
      }),
    ];
    for (let index = 0; index < safeClicks; index += 1) {
      lines.push(`[Win32.Win32Input]::mouse_event(${downFlags}, 0, 0, 0, 0)`);
      lines.push(`[Win32.Win32Input]::mouse_event(${upFlags}, 0, 0, 0, 0)`);
    }
    lines.push(
      ...[...normalizedModifiers].reverse().map((modifier) => {
        const vk = vkCodes[modifier.trim().toLowerCase()];
        if (!vk) {
          throw new Error(`Unsupported modifier key: "${modifier}"`);
        }
        return `[Win32.Win32Input]::keybd_event(${vk}, 0, 0x0002, 0)`;
      }),
    );
    runCommand("powershell", ["-Command", lines.join("; ")], 7000);
  }
}

// ── Double Click ────────────────────────────────────────────────────────────

export function desktopDoubleClick(x: number, y: number): void {
  const sx = validateInt(x);
  const sy = validateInt(y);
  const os = currentPlatform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`dc:${sx},${sy}`], 5000);
    } else {
      runCommand(
        "osascript",
        ["-e", `tell application "System Events" to click at {${sx}, ${sy}}\ntell application "System Events" to click at {${sx}, ${sy}}`],
        5000,
      );
    }
  } else if (os === "linux") {
    requireXdotool();
    runCommand("xdotool", ["mousemove", String(sx), String(sy), "click", "--repeat", "2", "1"], 5000);
  } else if (os === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
      "[Win32.Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)",
      "[Win32.Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)",
    ].join("; ");
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Right Click ─────────────────────────────────────────────────────────────

export function desktopRightClick(x: number, y: number): void {
  const sx = validateInt(x);
  const sy = validateInt(y);
  const os = currentPlatform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`rc:${sx},${sy}`], 5000);
    } else {
      runCommand(
        "osascript",
        ["-e", `tell application "System Events" to click at {${sx}, ${sy}} using {control down}`],
        5000,
      );
    }
  } else if (os === "linux") {
    requireXdotool();
    runCommand("xdotool", ["mousemove", String(sx), String(sy), "click", "3"], 5000);
  } else if (os === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
      "[Win32.Win32Mouse]::mouse_event(0x0008, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(0x0010, 0, 0, 0, 0)",
    ].join("; ");
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Mouse Move ──────────────────────────────────────────────────────────────

export function desktopMouseMove(x: number, y: number): void {
  const sx = validateInt(x);
  const sy = validateInt(y);
  const os = currentPlatform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`m:${sx},${sy}`], 5000);
    } else {
      // AppleScript doesn't have a native mouse-move; use cliclick if available
      runCommand(
        "osascript",
        ["-e", `do shell script "cliclick m:${sx},${sy}" & `],
        5000,
      );
    }
  } else if (os === "linux") {
    requireXdotool();
    runCommand("xdotool", ["mousemove", String(sx), String(sy)], 5000);
  } else if (os === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
    ].join("; ");
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Drag ────────────────────────────────────────────────────────────────────

export function desktopDrag(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const sx1 = validateInt(x1);
  const sy1 = validateInt(y1);
  const sx2 = validateInt(x2);
  const sy2 = validateInt(y2);
  const os = currentPlatform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`dd:${sx1},${sy1}`, `du:${sx2},${sy2}`], 10000);
    } else {
      // AppleScript drag is limited; best-effort
      const script = [
        `tell application "System Events"`,
        `  click at {${sx1}, ${sy1}}`,
        `  delay 0.1`,
        `  click at {${sx2}, ${sy2}}`,
        `end tell`,
      ].join("\n");
      runCommand("osascript", ["-e", script], 10000);
    }
  } else if (os === "linux") {
    requireXdotool();
    runCommand(
      "xdotool",
      [
        "mousemove", String(sx1), String(sy1),
        "mousedown", "1",
        "mousemove", "--sync", String(sx2), String(sy2),
        "mouseup", "1",
      ],
      10000,
    );
  } else if (os === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx1},${sy1})`,
      "Start-Sleep -Milliseconds 50",
      "[Win32.Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0)", // left down
      "Start-Sleep -Milliseconds 50",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx2},${sy2})`,
      "Start-Sleep -Milliseconds 50",
      "[Win32.Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)", // left up
    ].join("; ");
    runCommand("powershell", ["-Command", ps], 10000);
  }
}

// ── Scroll ──────────────────────────────────────────────────────────────────

export function desktopScroll(
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount = 3,
): void {
  const sx = validateInt(x);
  const sy = validateInt(y);
  const clicks = Math.max(1, Math.min(validateInt(amount), 100));
  const os = currentPlatform();

  if (os === "darwin") {
    // Move mouse first, then scroll
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`m:${sx},${sy}`], 3000);
    }
    // AppleScript scroll using System Events
    const scrollDir = direction === "up" || direction === "left" ? -1 : 1;
    const axis = direction === "left" || direction === "right" ? "horizontal" : "vertical";
    if (axis === "vertical") {
      const script = `tell application "System Events" to scroll area 1 of scroll area 1`;
      // Use cliclick scroll if available, otherwise AppleScript key presses
      if (commandExists("cliclick")) {
        // cliclick doesn't have scroll — use key arrows
        const key = direction === "up" ? "arrow-up" : "arrow-down";
        for (let i = 0; i < clicks; i++) {
          runCommand("cliclick", [`kp:${key}`], 2000);
        }
      } else {
        const keyCode = direction === "up" ? 126 : 125; // up=126 down=125
        for (let i = 0; i < clicks; i++) {
          runCommand(
            "osascript",
            ["-e", `tell application "System Events" to key code ${keyCode}`],
            2000,
          );
        }
      }
    } else {
      const keyCode = direction === "left" ? 123 : 124; // left=123 right=124
      for (let i = 0; i < clicks; i++) {
        runCommand(
          "osascript",
          ["-e", `tell application "System Events" to key code ${keyCode}`],
          2000,
        );
      }
    }
  } else if (os === "linux") {
    requireXdotool();
    // Move to position first
    runCommand("xdotool", ["mousemove", String(sx), String(sy)], 3000);
    // xdotool: button 4=scroll up, 5=scroll down, 6=scroll left, 7=scroll right
    const button =
      direction === "up" ? "4" :
      direction === "down" ? "5" :
      direction === "left" ? "6" : "7";
    for (let i = 0; i < clicks; i++) {
      runCommand("xdotool", ["click", button], 2000);
    }
  } else if (os === "win32") {
    // MOUSEEVENTF_WHEEL = 0x0800, positive = up, negative = down
    // Each wheel click is 120 units
    const wheelDelta = (direction === "up" || direction === "left" ? 1 : -1) * 120 * clicks;
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
      `[Win32.Win32Mouse]::mouse_event(0x0800, 0, 0, ${wheelDelta}, 0)`,
    ].join("; ");
    runCommand("powershell", ["-Command", ps], 5000);
  }
}

// ── Type Text ───────────────────────────────────────────────────────────────

export function desktopType(text: string): void {
  const safeText = validateText(text);
  const os = currentPlatform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`t:${safeText}`], 10000);
    } else {
      runCommand(
        "osascript",
        [
          "-e",
          `tell application "System Events" to keystroke ${escapeAppleScript(safeText)}`,
        ],
        10000,
      );
    }
  } else if (os === "linux") {
    requireXdotool();
    runCommand("xdotool", ["type", "--", safeText], 10000);
  } else if (os === "win32") {
    const escaped = safeText.replace(/'/g, "''");
    runCommand(
      "powershell",
      [
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
      ],
      10000,
    );
  }
}

// ── Key Press ───────────────────────────────────────────────────────────────

/**
 * Press a single key by name (e.g. "Return", "Tab", "Escape", "F5").
 */
export function desktopKeyPress(key: string): void {
  const safeKey = validateKeypress(key);
  const os = currentPlatform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`kp:${toCliclickKeyName(safeKey)}`], 5000);
    } else {
      // Map common key names to macOS key codes
      const keyCodes: Record<string, number> = {
        return: 36, enter: 36, tab: 48, space: 49,
        escape: 53, esc: 53,
        delete: 51, backspace: 51, forwarddelete: 117,
        left: 123, right: 124, down: 125, up: 126,
        home: 115, end: 119, pageup: 116, pagedown: 121,
        f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
        f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
      };
      const normalized = canonicalKeyName(safeKey);
      const code = keyCodes[normalized];
      if (code !== undefined) {
        runCommand(
          "osascript",
          ["-e", `tell application "System Events" to key code ${code}`],
          5000,
        );
      } else {
        runCommand(
          "osascript",
          ["-e", `tell application "System Events" to keystroke ${escapeAppleScript(safeKey)}`],
          5000,
        );
      }
    }
  } else if (os === "linux") {
    requireXdotool();
    const xKey = safeXdotoolKey(toXdotoolKeyName(safeKey));
    runCommand("xdotool", ["key", xKey], 5000);
  } else if (os === "win32") {
    const escaped = toWindowsSendKey(safeKey).replace(/'/g, "''");
    runCommand(
      "powershell",
      [
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
      ],
      5000,
    );
  }
}

// ── Key Combo ───────────────────────────────────────────────────────────────

/**
 * Press a key combination like "ctrl+c", "cmd+shift+s", "alt+F4".
 * Modifier names: ctrl, shift, alt, cmd/meta/super.
 *
 * Ported from open-computer-use desktopKeyCombo().
 */
export function desktopKeyCombo(combo: string): void {
  const safeCombo = validateKeypress(combo);
  const parts = safeCombo.split("+").map((p) => p.trim().toLowerCase());
  const os = currentPlatform();

  if (os === "darwin") {
    // Map modifier names to AppleScript "using" clauses
    const modifierMap: Record<string, string> = {
      cmd: "command down", command: "command down", meta: "command down", super: "command down",
      ctrl: "control down", control: "control down",
      shift: "shift down",
      alt: "option down", option: "option down",
    };
    const modifiers: string[] = [];
    let key = "";
    for (const part of parts) {
      if (modifierMap[part]) {
        modifiers.push(modifierMap[part]);
      } else {
        key = part;
      }
    }
    const using = modifiers.length > 0
      ? ` using {${modifiers.join(", ")}}`
      : "";
    runCommand(
      "osascript",
      ["-e", `tell application "System Events" to keystroke ${escapeAppleScript(key)}${using}`],
      5000,
    );
  } else if (os === "linux") {
    requireXdotool();
    // xdotool key combo: "ctrl+c" → "ctrl+c" (xdotool understands this directly)
    const xParts = parts.map((p) => {
      const xMap: Record<string, string> = {
        cmd: "super", command: "super", meta: "super",
        ctrl: "ctrl", control: "ctrl",
      };
      return xMap[p] ?? p;
    });
    runCommand("xdotool", ["key", xParts.join("+")], 5000);
  } else if (os === "win32") {
    // PowerShell SendKeys: ^ = Ctrl, + = Shift, % = Alt
    const psModMap: Record<string, string> = {
      ctrl: "^", control: "^",
      shift: "+",
      alt: "%",
      cmd: "^", command: "^", meta: "^", super: "^", // Map cmd → ctrl on Windows
    };
    let prefix = "";
    let key = "";
    for (const part of parts) {
      if (psModMap[part]) {
        prefix += psModMap[part];
      } else {
        key = part;
      }
    }
    const sendKey = `${prefix}${key}`.replace(/'/g, "''");
    runCommand(
      "powershell",
      [
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKey}')`,
      ],
      5000,
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function requireXdotool(): void {
  if (!commandExists("xdotool")) {
    throw new Error(
      "xdotool is required for mouse/keyboard control on Linux. Install via: sudo apt install xdotool",
    );
  }
}
