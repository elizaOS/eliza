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
import {
  classifyPermissionDeniedError,
  isPermissionDeniedError,
} from "./permissions.js";

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

function toAppleScriptKeyCode(key: string): number | null {
  const canonical = canonicalKeyName(key);
  const keyCodes: Record<string, number> = {
    enter: 36,
    return: 36,
    tab: 48,
    space: 49,
    escape: 53,
    delete: 51,
    backspace: 51,
    left: 123,
    right: 124,
    down: 125,
    up: 126,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
  };
  return keyCodes[canonical] ?? null;
}

function runDarwinJxa(script: string, timeoutMs = 5000): void {
  runCommand("osascript", ["-l", "JavaScript", "-e", script], timeoutMs);
}

function moveMouseDarwin(x: number, y: number): void {
  runDarwinJxa(
    `
ObjC.import("ApplicationServices");
const point = $.CGPointMake(${x}, ${y});
const event = $.CGEventCreateMouseEvent(
  null,
  $.kCGEventMouseMoved,
  point,
  $.kCGMouseButtonLeft
);
$.CGEventPost($.kCGHIDEventTap, event);
`,
  );
}

function clickDarwinWithCoreGraphics(
  x: number,
  y: number,
  button: "left" | "right",
  clickCount = 1,
): void {
  const downEvent =
    button === "right" ? "$.kCGEventRightMouseDown" : "$.kCGEventLeftMouseDown";
  const upEvent =
    button === "right" ? "$.kCGEventRightMouseUp" : "$.kCGEventLeftMouseUp";
  const mouseButton =
    button === "right" ? "$.kCGMouseButtonRight" : "$.kCGMouseButtonLeft";
  runDarwinJxa(
    `
ObjC.import("ApplicationServices");
const point = $.CGPointMake(${x}, ${y});
for (let clickIndex = 1; clickIndex <= ${clickCount}; clickIndex += 1) {
  const down = $.CGEventCreateMouseEvent(null, ${downEvent}, point, ${mouseButton});
  $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, clickIndex);
  $.CGEventPost($.kCGHIDEventTap, down);
  const up = $.CGEventCreateMouseEvent(null, ${upEvent}, point, ${mouseButton});
  $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, clickIndex);
  $.CGEventPost($.kCGHIDEventTap, up);
}
`,
  );
}

function scrollDarwin(
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount: number,
): void {
  const vertical =
    direction === "up" ? amount : direction === "down" ? -amount : 0;
  const horizontal =
    direction === "left" ? amount : direction === "right" ? -amount : 0;
  runDarwinJxa(
    `
ObjC.import("ApplicationServices");
const point = $.CGPointMake(${x}, ${y});
const moveEvent = $.CGEventCreateMouseEvent(
  null,
  $.kCGEventMouseMoved,
  point,
  $.kCGMouseButtonLeft
);
$.CGEventPost($.kCGHIDEventTap, moveEvent);
const scrollEvent = $.CGEventCreateScrollWheelEvent(
  null,
  $.kCGScrollEventUnitLine,
  2,
  ${vertical},
  ${horizontal}
);
$.CGEventPost($.kCGHIDEventTap, scrollEvent);
`,
  );
}

// ── Mouse Click ─────────────────────────────────────────────────────────────

export function desktopClick(x: number, y: number): void {
  runWithAccessibilityPermission(
    "desktop_click",
    () => {
      const sx = validateInt(x);
      const sy = validateInt(y);
      const os = currentPlatform();

      if (os === "darwin") {
        if (commandExists("cliclick")) {
          runCommand("cliclick", [`c:${sx},${sy}`], 5000);
        } else {
          runCommand(
            "osascript",
            [
              "-e",
              `tell application "System Events" to click at {${sx}, ${sy}}`,
            ],
            5000,
          );
        }
      } else if (os === "linux") {
        requireXdotool();
        runCommand(
          "xdotool",
          ["mousemove", String(sx), String(sy), "click", "1"],
          5000,
        );
      } else if (os === "win32") {
        const ps = [
          "Add-Type -AssemblyName System.Windows.Forms",
          `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
          `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
          "[Win32.Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)",
        ].join("; ");
        runCommand("powershell", ["-Command", ps], 5000);
      }
    },
    "desktop_click",
  );
}

export function desktopClickWithModifiers(
  x: number,
  y: number,
  modifiers: string[],
): void {
  runWithAccessibilityPermission(
    "desktop_click_with_modifiers",
    () => {
      const sx = validateInt(x);
      const sy = validateInt(y);
      const os = currentPlatform();
      const normalizedModifiers = normalizeModifiers(modifiers);

      if (normalizedModifiers.length === 0) {
        desktopClick(sx, sy);
        return;
      }

      if (os === "darwin") {
        const flagMap: Record<string, string> = {
          cmd: ".maskCommand",
          command: ".maskCommand",
          meta: ".maskCommand",
          super: ".maskCommand",
          ctrl: ".maskControl",
          control: ".maskControl",
          alt: ".maskAlternate",
          option: ".maskAlternate",
          shift: ".maskShift",
        };
        const flags = normalizedModifiers
          .map((modifier) => flagMap[modifier])
          .filter(Boolean);
        const flagExpr = flags.length > 0 ? `[${flags.join(", ")}]` : "[]";
        const swiftScript = `
import Cocoa
let point = CGPoint(x: ${sx}, y: ${sy})
let flags: CGEventFlags = ${flagExpr}
let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
down?.flags = flags
down?.post(tap: .cghidEventTap)
let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
up?.flags = flags
up?.post(tap: .cghidEventTap)
`;
        runCommand("swift", ["-e", swiftScript], 10000);
        return;
      }

      if (os === "linux") {
        requireXdotool();
        const modMap: Record<string, string> = {
          cmd: "super",
          command: "super",
          meta: "super",
          super: "super",
          ctrl: "ctrl",
          control: "ctrl",
          alt: "alt",
          option: "alt",
          shift: "shift",
        };
        const keys = normalizedModifiers.map(
          (modifier) => modMap[modifier] ?? modifier,
        );
        runCommand(
          "xdotool",
          [
            ...keys.flatMap((key) => ["keydown", key]),
            "mousemove",
            String(sx),
            String(sy),
            "click",
            "1",
            ...[...keys].reverse().flatMap((key) => ["keyup", key]),
          ],
          5000,
        );
        return;
      }

      if (os === "win32") {
        const vkMap: Record<string, number> = {
          cmd: 0x5b,
          command: 0x5b,
          meta: 0x5b,
          super: 0x5b,
          ctrl: 0x11,
          control: 0x11,
          alt: 0x12,
          option: 0x12,
          shift: 0x10,
        };
        const keyDown = normalizedModifiers
          .map((modifier) => vkMap[modifier])
          .filter((code): code is number => Number.isFinite(code))
          .map(
            (code) => `[Win32.Win32Keyboard]::keybd_event(${code}, 0, 0, 0)`,
          );
        const keyUp = [...normalizedModifiers]
          .reverse()
          .map((modifier) => vkMap[modifier])
          .filter((code): code is number => Number.isFinite(code))
          .map(
            (code) => `[Win32.Win32Keyboard]::keybd_event(${code}, 0, 2, 0)`,
          );
        const ps = [
          "Add-Type -AssemblyName System.Windows.Forms",
          `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
          `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo); [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);' -Name Win32Keyboard -Namespace Win32`,
          ...keyDown,
          "[Win32.Win32Keyboard]::mouse_event(0x0002, 0, 0, 0, 0); [Win32.Win32Keyboard]::mouse_event(0x0004, 0, 0, 0, 0)",
          ...keyUp,
        ].join("; ");
        runCommand("powershell", ["-Command", ps], 5000);
      }
    },
    "desktop_click_with_modifiers",
  );
}

// ── Double Click ────────────────────────────────────────────────────────────

export function desktopDoubleClick(x: number, y: number): void {
  runWithAccessibilityPermission(
    "desktop_double_click",
    () => {
      const sx = validateInt(x);
      const sy = validateInt(y);
      const os = currentPlatform();

      if (os === "darwin") {
        if (commandExists("cliclick")) {
          runCommand("cliclick", [`dc:${sx},${sy}`], 5000);
        } else {
          const swiftScript = `
import Cocoa
let point = CGPoint(x: ${sx}, y: ${sy})
let down1 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
down1?.setIntegerValueField(.mouseEventClickState, value: 1)
down1?.post(tap: .cghidEventTap)
let up1 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
up1?.setIntegerValueField(.mouseEventClickState, value: 1)
up1?.post(tap: .cghidEventTap)
usleep(50000)
let down2 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
down2?.setIntegerValueField(.mouseEventClickState, value: 2)
down2?.post(tap: .cghidEventTap)
let up2 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
up2?.setIntegerValueField(.mouseEventClickState, value: 2)
up2?.post(tap: .cghidEventTap)
`;
          runCommand("swift", ["-e", swiftScript], 10000);
        }
      } else if (os === "linux") {
        requireXdotool();
        runCommand(
          "xdotool",
          ["mousemove", String(sx), String(sy), "click", "--repeat", "2", "1"],
          5000,
        );
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
    },
    "desktop_double_click",
  );
}

// ── Right Click ─────────────────────────────────────────────────────────────

export function desktopRightClick(x: number, y: number): void {
  runWithAccessibilityPermission(
    "desktop_right_click",
    () => {
      const sx = validateInt(x);
      const sy = validateInt(y);
      const os = currentPlatform();

      if (os === "darwin") {
        if (commandExists("cliclick")) {
          runCommand("cliclick", [`rc:${sx},${sy}`], 5000);
        } else {
          const swiftScript = `
import Cocoa
let point = CGPoint(x: ${sx}, y: ${sy})
CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right)?.post(tap: .cghidEventTap)
`;
          runCommand("swift", ["-e", swiftScript], 10000);
        }
      } else if (os === "linux") {
        requireXdotool();
        runCommand(
          "xdotool",
          ["mousemove", String(sx), String(sy), "click", "3"],
          5000,
        );
      } else if (os === "win32") {
        const ps = [
          "Add-Type -AssemblyName System.Windows.Forms",
          `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
          `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
          "[Win32.Win32Mouse]::mouse_event(0x0008, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(0x0010, 0, 0, 0, 0)",
        ].join("; ");
        runCommand("powershell", ["-Command", ps], 5000);
      }
    },
    "desktop_right_click",
  );
}

// ── Mouse Move ──────────────────────────────────────────────────────────────

export function desktopMouseMove(x: number, y: number): void {
  runWithAccessibilityPermission(
    "desktop_mouse_move",
    () => {
      const sx = validateInt(x);
      const sy = validateInt(y);
      const os = currentPlatform();

      if (os === "darwin") {
        if (commandExists("cliclick")) {
          runCommand("cliclick", [`m:${sx},${sy}`], 5000);
        } else {
          // JXA (JavaScript for Automation) CoreGraphics fallback — no deps.
          const jxa = `ObjC.import('CoreGraphics'); const e = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, {x:${sx}, y:${sy}}, $.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap, e);`;
          runCommand("osascript", ["-l", "JavaScript", "-e", jxa], 5000);
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
    },
    "desktop_mouse_move",
  );
}

// ── Drag ────────────────────────────────────────────────────────────────────

export function desktopDrag(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  runWithAccessibilityPermission(
    "desktop_drag",
    () => {
      const sx1 = validateInt(x1);
      const sy1 = validateInt(y1);
      const sx2 = validateInt(x2);
      const sy2 = validateInt(y2);
      const os = currentPlatform();

      if (os === "darwin") {
        if (commandExists("cliclick")) {
          runCommand(
            "cliclick",
            [`dd:${sx1},${sy1}`, `du:${sx2},${sy2}`],
            10000,
          );
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
            "mousemove",
            String(sx1),
            String(sy1),
            "mousedown",
            "1",
            "mousemove",
            "--sync",
            String(sx2),
            String(sy2),
            "mouseup",
            "1",
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
    },
    "desktop_drag",
  );
}

// ── Scroll ──────────────────────────────────────────────────────────────────

export function desktopScroll(
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount = 3,
): void {
  runWithAccessibilityPermission(
    "desktop_scroll",
    () => {
      const sx = validateInt(x);
      const sy = validateInt(y);
      const clicks = Math.max(1, Math.min(validateInt(amount), 20));
      const os = currentPlatform();

      if (os === "darwin") {
        // JXA CGEventCreateScrollWheelEvent — works without cliclick.
        // For vertical scrolls, positive Y deltas scroll up, negative scrolls down.
        // For horizontal, positive X deltas scroll right, negative scrolls left.
        const axis =
          direction === "left" || direction === "right"
            ? "horizontal"
            : "vertical";
        const delta =
          direction === "up" || direction === "left" ? clicks : -clicks;
        const jxa =
          axis === "vertical"
            ? `ObjC.import('CoreGraphics'); const e = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, ${delta}); $.CGEventPost($.kCGHIDEventTap, e);`
            : `ObjC.import('CoreGraphics'); const e = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, 0, ${delta}); $.CGEventPost($.kCGHIDEventTap, e);`;
        runCommand("osascript", ["-l", "JavaScript", "-e", jxa], 5000);
      } else if (os === "linux") {
        requireXdotool();
        // Move to position first
        runCommand("xdotool", ["mousemove", String(sx), String(sy)], 3000);
        // xdotool: button 4=scroll up, 5=scroll down, 6=scroll left, 7=scroll right
        const button =
          direction === "up"
            ? "4"
            : direction === "down"
              ? "5"
              : direction === "left"
                ? "6"
                : "7";
        for (let i = 0; i < clicks; i++) {
          runCommand("xdotool", ["click", button], 2000);
        }
      } else if (os === "win32") {
        // MOUSEEVENTF_WHEEL = 0x0800, positive = up, negative = down
        // Each wheel click is 120 units
        const wheelDelta =
          (direction === "up" || direction === "left" ? 1 : -1) * 120 * clicks;
        const ps = [
          "Add-Type -AssemblyName System.Windows.Forms",
          `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
          `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
          `[Win32.Win32Mouse]::mouse_event(0x0800, 0, 0, ${wheelDelta}, 0)`,
        ].join("; ");
        runCommand("powershell", ["-Command", ps], 5000);
      }
    },
    "desktop_scroll",
  );
}

// ── Type Text ───────────────────────────────────────────────────────────────

export function desktopType(text: string): void {
  runWithAccessibilityPermission(
    "desktop_type",
    () => {
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
    },
    "desktop_type",
  );
}

// ── Key Press ───────────────────────────────────────────────────────────────

/**
 * Press a single key by name (e.g. "Return", "Tab", "Escape", "F5").
 */
export function desktopKeyPress(key: string): void {
  runWithAccessibilityPermission(
    "desktop_key_press",
    () => {
      const safeKey = validateKeypress(key);
      const os = currentPlatform();

      if (os === "darwin") {
        if (commandExists("cliclick")) {
          runCommand("cliclick", [`kp:${toCliclickKeyName(safeKey)}`], 5000);
        } else {
          // Map common key names to macOS key codes
          const keyCodes: Record<string, number> = {
            return: 36,
            enter: 36,
            tab: 48,
            space: 49,
            escape: 53,
            esc: 53,
            delete: 51,
            backspace: 51,
            forwarddelete: 117,
            left: 123,
            right: 124,
            down: 125,
            up: 126,
            home: 115,
            end: 119,
            pageup: 116,
            pagedown: 121,
            f1: 122,
            f2: 120,
            f3: 99,
            f4: 118,
            f5: 96,
            f6: 97,
            f7: 98,
            f8: 100,
            f9: 101,
            f10: 109,
            f11: 103,
            f12: 111,
          };
          const normalized = safeKey.trim().toLowerCase();
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
              [
                "-e",
                `tell application "System Events" to keystroke ${escapeAppleScript(safeKey)}`,
              ],
              5000,
            );
          }
        }
      } else if (os === "linux") {
        requireXdotool();
        const xKey = safeXdotoolKey(safeKey);
        runCommand("xdotool", ["key", xKey], 5000);
      } else if (os === "win32") {
        const escaped = safeKey.replace(/'/g, "''");
        runCommand(
          "powershell",
          [
            "-Command",
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
          ],
          5000,
        );
      }
    },
    "desktop_key_press",
  );
}

// ── Key Combo ───────────────────────────────────────────────────────────────

/**
 * Press a key combination like "ctrl+c", "cmd+shift+s", "alt+F4".
 * Modifier names: ctrl, shift, alt, cmd/meta/super.
 *
 * Ported from open-computer-use desktopKeyCombo().
 */
export function desktopKeyCombo(combo: string): void {
  runWithAccessibilityPermission(
    "desktop_key_combo",
    () => {
      const safeCombo = validateKeypress(combo);
      const parts = safeCombo.split("+").map((p) => p.trim().toLowerCase());
      const os = currentPlatform();

      if (os === "darwin") {
        // Map modifier names to AppleScript "using" clauses
        const modifierMap: Record<string, string> = {
          cmd: "command down",
          command: "command down",
          meta: "command down",
          super: "command down",
          ctrl: "control down",
          control: "control down",
          shift: "shift down",
          alt: "option down",
          option: "option down",
        };
        const macKeyCodes: Record<string, number> = {
          return: 36,
          enter: 36,
          tab: 48,
          space: 49,
          escape: 53,
          esc: 53,
          delete: 51,
          backspace: 51,
          forwarddelete: 117,
          left: 123,
          right: 124,
          down: 125,
          up: 126,
          home: 115,
          end: 119,
          pageup: 116,
          pagedown: 121,
          f1: 122,
          f2: 120,
          f3: 99,
          f4: 118,
          f5: 96,
          f6: 97,
          f7: 98,
          f8: 100,
          f9: 101,
          f10: 109,
          f11: 103,
          f12: 111,
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
        const using =
          modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
        const canonical = canonicalKeyName(key);
        const keyCode = macKeyCodes[canonical];
        const command =
          keyCode !== undefined
            ? `tell application "System Events" to key code ${keyCode}${using}`
            : `tell application "System Events" to keystroke ${escapeAppleScript(key)}${using}`;
        runCommand("osascript", ["-e", command], 5000);
      } else if (os === "linux") {
        requireXdotool();
        // xdotool key combo: "ctrl+c" → "ctrl+c" (xdotool understands this directly)
        const xParts = parts.map((p) => {
          const xMap: Record<string, string> = {
            cmd: "super",
            command: "super",
            meta: "super",
            ctrl: "ctrl",
            control: "ctrl",
          };
          return xMap[p] ?? toXdotoolKeyName(p);
        });
        runCommand("xdotool", ["key", xParts.join("+")], 5000);
      } else if (os === "win32") {
        // PowerShell SendKeys: ^ = Ctrl, + = Shift, % = Alt
        const psModMap: Record<string, string> = {
          ctrl: "^",
          control: "^",
          shift: "+",
          alt: "%",
          cmd: "^",
          command: "^",
          meta: "^",
          super: "^", // Map cmd → ctrl on Windows
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
        const mappedKey = toWindowsSendKey(key);
        const sendKey = `${prefix}${mappedKey}`.replace(/'/g, "''");
        runCommand(
          "powershell",
          [
            "-Command",
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKey}')`,
          ],
          5000,
        );
      }
    },
    "desktop_key_combo",
  );
}

function runWithAccessibilityPermission<T>(
  operation: string,
  handler: () => T,
  _command?: string,
): T {
  try {
    return handler();
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      throw error;
    }
    const permissionError = classifyPermissionDeniedError(error, {
      permissionType: "accessibility",
      operation,
    });
    if (permissionError) {
      throw permissionError;
    }
    throw error;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeModifiers(modifiers: string[]): string[] {
  const normalized = modifiers
    .map((modifier) => modifier.trim().toLowerCase())
    .filter(Boolean);

  for (const modifier of normalized) {
    if (
      ![
        "cmd",
        "command",
        "meta",
        "super",
        "ctrl",
        "control",
        "alt",
        "option",
        "shift",
      ].includes(modifier)
    ) {
      throw new Error(`Unsupported modifier key: ${modifier}`);
    }
  }

  return normalized;
}

function requireXdotool(): void {
  if (!commandExists("xdotool")) {
    throw new Error(
      "xdotool is required for mouse/keyboard control on Linux. Install via: sudo apt install xdotool",
    );
  }
}
