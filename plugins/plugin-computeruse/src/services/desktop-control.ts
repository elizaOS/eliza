import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

export type DesktopInputButton = "left" | "right";

export interface DesktopScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindowInfo {
  id: string;
  title: string;
  app: string;
}

export interface DesktopControlCapability {
  available: boolean;
  tool: string;
}

export interface DesktopControlCapabilities {
  screenshot: DesktopControlCapability;
  computerUse: DesktopControlCapability;
  windowList: DesktopControlCapability;
  headfulGui: DesktopControlCapability;
}

export function isHeadfulGuiAvailable(): boolean {
  const os = platform();
  if (os === "darwin" || os === "win32") {
    return true;
  }
  if (os === "linux") {
    return Boolean(
      process.env.DISPLAY?.trim() ||
        process.env.WAYLAND_DISPLAY?.trim() ||
        process.env.MIR_SOCKET?.trim(),
    );
  }
  return false;
}

export function commandExists(command: string): boolean {
  try {
    const which = platform() === "win32" ? "where" : "which";
    execFileSync(which, [command], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export function captureDesktopScreenshot(
  region?: DesktopScreenshotRegion,
): Buffer {
  const os = platform();
  const tmpFile = join(tmpdir(), `desktop-screenshot-${Date.now()}.png`);

  try {
    if (os === "darwin") {
      if (region) {
        runMacScreenshotCommand([
          `-R${region.x},${region.y},${region.width},${region.height}`,
          "-x",
          tmpFile,
        ]);
      } else {
        runMacScreenshotCommand(["-x", tmpFile]);
      }
    } else if (os === "linux") {
      if (!isHeadfulGuiAvailable()) {
        throw new Error("No Linux GUI display is available.");
      }
      if (commandExists("import")) {
        if (region) {
          runCommand(
            "import",
            [
              "-window",
              "root",
              "-crop",
              `${region.width}x${region.height}+${region.x}+${region.y}`,
              tmpFile,
            ],
            10000,
          );
        } else {
          runCommand("import", ["-window", "root", tmpFile], 10000);
        }
      } else if (commandExists("scrot")) {
        runCommand("scrot", [tmpFile], 10000);
      } else if (commandExists("gnome-screenshot")) {
        runCommand("gnome-screenshot", ["-f", tmpFile], 10000);
      } else {
        throw new Error(
          "No screenshot tool available. Install ImageMagick, scrot, or gnome-screenshot.",
        );
      }
    } else if (os === "win32") {
      const windowsPath = tmpFile.replace(/\//g, "\\").replace(/'/g, "''");
      const psCommand = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)",
        "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
        "$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)",
        `$bitmap.Save('${windowsPath}')`,
        "$graphics.Dispose()",
        "$bitmap.Dispose()",
      ].join("; ");
      execFileSync("powershell", ["-Command", psCommand], {
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      throw new Error(`Screenshot not supported on platform: ${os}`);
    }

    const data = readFileSync(tmpFile);
    removeTempFile(tmpFile);
    return data;
  } catch (error) {
    removeTempFile(tmpFile);
    throw error;
  }
}

export function listDesktopWindows(): DesktopWindowInfo[] {
  const os = platform();

  if (os === "darwin") {
    const script = `
        tell application "System Events"
          set previousDelimiters to AppleScript's text item delimiters
          set AppleScript's text item delimiters to linefeed
          set windowList to {}
          repeat with proc in (every process whose visible is true)
            try
              repeat with w in (every window of proc)
                set end of windowList to (name of proc) & "|||" & (name of w) & "|||" & (id of w as text)
              end repeat
            end try
          end repeat
          set serializedWindowList to windowList as text
          set AppleScript's text item delimiters to previousDelimiters
          return serializedWindowList
        end tell`;
    let output: string;
    try {
      output = execFileSync("osascript", ["-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      throw new Error(
        "Window listing failed. Grant Accessibility permission to this app or terminal and try again.",
      );
    }
    return output
      .split("\n")
      .filter(Boolean)
      .map((entry) => {
        const parts = entry.split("|||");
        return {
          app: parts[0] ?? "unknown",
          title: parts[1] ?? "unknown",
          id: parts[2] ?? "0",
        };
      });
  }

  if (os === "linux") {
    if (commandExists("wmctrl")) {
      const output = execFileSync("wmctrl", ["-l"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\S+)\s+\S+\s+\S+\s*(.*)$/);
          return {
            id: match?.[1] ?? "0",
            title: match?.[2]?.trim() || line.trim(),
            app: "unknown",
          };
        });
    }
    if (commandExists("xdotool")) {
      const output = execFileSync(
        "sh",
        ["-c", 'xdotool search --name "" getwindowname 2>/dev/null'],
        {
          encoding: "utf-8",
          timeout: 5000,
        },
      );
      return output
        .split("\n")
        .filter(Boolean)
        .map((title, index) => ({
          id: String(index),
          title: title.trim(),
          app: "unknown",
        }));
    }
  }

  if (os === "win32") {
    const output = execFileSync(
      "powershell",
      [
        "-Command",
        "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object Id, MainWindowTitle | ConvertTo-Json",
      ],
      { encoding: "utf-8", timeout: 10000 },
    );
    if (!output.trim()) {
      return [];
    }
    const parsed = JSON.parse(output) as
      | { Id: number; MainWindowTitle: string }
      | Array<{ Id: number; MainWindowTitle: string }>;
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    return processes.map((process) => ({
      id: String(process.Id),
      title: process.MainWindowTitle,
      app: "unknown",
    }));
  }

  return [];
}

export function performDesktopClick(
  x: number,
  y: number,
  button: DesktopInputButton = "left",
): void {
  const os = platform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      const clickCommand = button === "right" ? "rc" : "c";
      runCommand("cliclick", [`${clickCommand}:${x},${y}`], 5000);
      return;
    }
    runCommand(
      "osascript",
      ["-e", `tell application "System Events" to click at {${x}, ${y}}`],
      5000,
    );
    return;
  }

  if (os === "linux") {
    if (!commandExists("xdotool")) {
      throw new Error("xdotool required for mouse control on Linux.");
    }
    const clickButton = button === "right" ? "3" : "1";
    runCommand(
      "xdotool",
      ["mousemove", String(x), String(y), "click", clickButton],
      5000,
    );
    return;
  }

  if (os === "win32") {
    runPowerShellMouseScript(x, y, button === "right" ? "right" : "left", 1);
    return;
  }

  throw new Error(`Mouse control not supported on platform: ${os}`);
}

export function performDesktopDoubleClick(
  x: number,
  y: number,
  button: DesktopInputButton = "left",
): void {
  const os = platform();

  if (os === "darwin" && commandExists("cliclick") && button === "left") {
    runCommand("cliclick", [`dc:${x},${y}`], 5000);
    return;
  }

  if (os === "linux") {
    if (!commandExists("xdotool")) {
      throw new Error("xdotool required for mouse control on Linux.");
    }
    const clickButton = button === "right" ? "3" : "1";
    runCommand(
      "xdotool",
      [
        "mousemove",
        String(x),
        String(y),
        "click",
        "--repeat",
        "2",
        clickButton,
      ],
      5000,
    );
    return;
  }

  if (os === "win32") {
    runPowerShellMouseScript(x, y, button === "right" ? "right" : "left", 2);
    return;
  }

  performDesktopClick(x, y, button);
  performDesktopClick(x, y, button);
}

export function performDesktopMouseMove(x: number, y: number): void {
  const os = platform();

  if (os === "darwin") {
    if (!commandExists("cliclick")) {
      throw new Error("cliclick required for mouse move on macOS.");
    }
    runCommand("cliclick", [`m:${x},${y}`], 5000);
    return;
  }

  if (os === "linux") {
    if (!commandExists("xdotool")) {
      throw new Error("xdotool required for mouse move on Linux.");
    }
    runCommand("xdotool", ["mousemove", String(x), String(y)], 5000);
    return;
  }

  if (os === "win32") {
    const psScript = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
    ].join("; ");
    runCommand("powershell", ["-Command", psScript], 5000);
    return;
  }

  throw new Error(`Mouse move not supported on platform: ${os}`);
}

export function performDesktopScroll(deltaX: number, deltaY: number): void {
  const os = platform();
  const normalizedX = clampScrollDelta(deltaX);
  const normalizedY = clampScrollDelta(deltaY);

  if (normalizedX === 0 && normalizedY === 0) {
    return;
  }

  if (os === "darwin") {
    const psScript = [
      'ObjC.import("ApplicationServices")',
      `const event = $.CGEventCreateScrollWheelEvent(null, 1, 2, ${-normalizedY}, ${-normalizedX})`,
      "$.CGEventPost(0, event)",
      "$.CFRelease(event)",
    ].join("; ");
    runCommand("osascript", ["-l", "JavaScript", "-e", psScript], 5000);
    return;
  }

  if (os === "linux") {
    if (!commandExists("xdotool")) {
      throw new Error("xdotool required for scroll on Linux.");
    }
    clickMouseWheel(normalizedY < 0 ? "4" : "5", Math.abs(normalizedY));
    clickMouseWheel(normalizedX < 0 ? "6" : "7", Math.abs(normalizedX));
    return;
  }

  if (os === "win32") {
    const psScript = [
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
      `[Win32.Win32Mouse]::mouse_event(0x0800, 0, 0, ${normalizedY * -120}, 0)`,
    ].join("; ");
    runCommand("powershell", ["-Command", psScript], 5000);
    return;
  }

  throw new Error(`Scroll not supported on platform: ${os}`);
}

export function performDesktopTextInput(text: string): void {
  const os = platform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`t:${text}`], 10000);
      return;
    }
    runCommand(
      "osascript",
      [
        "-e",
        `tell application "System Events" to keystroke ${toAppleScriptStringLiteral(text)}`,
      ],
      10000,
    );
    return;
  }

  if (os === "linux") {
    if (!commandExists("xdotool")) {
      throw new Error("xdotool required for keyboard input on Linux.");
    }
    runCommand("xdotool", ["type", "--", text], 10000);
    return;
  }

  if (os === "win32") {
    const escaped = text.replace(/'/g, "''");
    runCommand(
      "powershell",
      [
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
      ],
      10000,
    );
    return;
  }

  throw new Error(`Text input not supported on platform: ${os}`);
}

export function performDesktopKeypress(keys: string): void {
  const os = platform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      const cliclickKey = toCliclickKey(keys);
      if (cliclickKey) {
        runCommand("cliclick", [`kp:${cliclickKey}`], 5000);
      } else {
        runCommand("cliclick", [`t:${keys}`], 5000);
      }
      return;
    }

    const keyCode = macKeyCode(keys);
    if (keyCode !== null) {
      runCommand(
        "osascript",
        ["-e", `tell application "System Events" to key code ${keyCode}`],
        5000,
      );
      return;
    }

    runCommand(
      "osascript",
      [
        "-e",
        `tell application "System Events" to keystroke ${toAppleScriptStringLiteral(keys)}`,
      ],
      5000,
    );
    return;
  }

  if (os === "linux") {
    if (!commandExists("xdotool")) {
      throw new Error("xdotool required for key input on Linux.");
    }
    runCommand("xdotool", ["key", toXdotoolKey(keys)], 5000);
    return;
  }

  if (os === "win32") {
    const escaped = toWindowsSendKey(keys).replace(/'/g, "''");
    runCommand(
      "powershell",
      [
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
      ],
      5000,
    );
    return;
  }

  throw new Error(`Key input not supported on platform: ${os}`);
}

function toCliclickKey(keys: string): string | null {
  const keyMap: Record<string, string> = {
    backspace: "delete",
    down: "arrow-down",
    enter: "enter",
    escape: "esc",
    esc: "esc",
    left: "arrow-left",
    right: "arrow-right",
    return: "return",
    space: "space",
    tab: "tab",
    up: "arrow-up",
  };
  return keyMap[keys.trim().toLowerCase()] ?? null;
}

function toXdotoolKey(keys: string): string {
  const keyMap: Record<string, string> = {
    backspace: "BackSpace",
    down: "Down",
    enter: "Return",
    escape: "Escape",
    esc: "Escape",
    left: "Left",
    right: "Right",
    return: "Return",
    space: "space",
    tab: "Tab",
    up: "Up",
  };
  const normalized = keys.trim().toLowerCase();
  return keyMap[normalized] ?? keys.trim();
}

function toWindowsSendKey(keys: string): string {
  const keyMap: Record<string, string> = {
    backspace: "{BACKSPACE}",
    down: "{DOWN}",
    enter: "{ENTER}",
    escape: "{ESC}",
    esc: "{ESC}",
    left: "{LEFT}",
    right: "{RIGHT}",
    return: "{ENTER}",
    space: " ",
    tab: "{TAB}",
    up: "{UP}",
  };
  const normalized = keys.trim().toLowerCase();
  return keyMap[normalized] ?? keys;
}

export function detectDesktopControlCapabilities(): DesktopControlCapabilities {
  const os = platform();
  const headfulGui = isHeadfulGuiAvailable();

  return {
    headfulGui: {
      available: headfulGui,
      tool: headfulGui ? "desktop session" : "no GUI display detected",
    },
    screenshot: detectScreenshotCapability(os),
    computerUse: detectComputerUseCapability(os),
    windowList: detectWindowListCapability(os),
  };
}

function detectScreenshotCapability(
  os: NodeJS.Platform,
): DesktopControlCapability {
  if (os === "darwin") {
    return canCaptureMacScreen()
      ? { available: true, tool: "screencapture (built-in)" }
      : {
          available: false,
          tool: "screencapture blocked (grant Screen Recording permission)",
        };
  }
  if (os === "linux") {
    if (!isHeadfulGuiAvailable()) {
      return { available: false, tool: "no GUI display detected" };
    }
    if (commandExists("import")) {
      return { available: true, tool: "ImageMagick import" };
    }
    if (commandExists("scrot")) {
      return { available: true, tool: "scrot" };
    }
    if (commandExists("gnome-screenshot")) {
      return { available: true, tool: "gnome-screenshot" };
    }
    return {
      available: false,
      tool: "none (install ImageMagick, scrot, or gnome-screenshot)",
    };
  }
  if (os === "win32") {
    return { available: true, tool: "PowerShell System.Drawing" };
  }
  return { available: false, tool: "unsupported platform" };
}

function detectComputerUseCapability(
  os: NodeJS.Platform,
): DesktopControlCapability {
  if (os === "darwin") {
    if (commandExists("cliclick")) {
      return { available: true, tool: "cliclick" };
    }
    return { available: true, tool: "AppleScript (limited)" };
  }
  if (os === "linux") {
    if (!isHeadfulGuiAvailable()) {
      return { available: false, tool: "no GUI display detected" };
    }
    if (commandExists("xdotool")) {
      return { available: true, tool: "xdotool" };
    }
    return { available: false, tool: "none (install xdotool)" };
  }
  if (os === "win32") {
    return { available: true, tool: "PowerShell SendKeys" };
  }
  return { available: false, tool: "unsupported platform" };
}

function detectWindowListCapability(
  os: NodeJS.Platform,
): DesktopControlCapability {
  if (os === "darwin") {
    return canUseMacSystemEvents()
      ? { available: true, tool: "AppleScript" }
      : {
          available: false,
          tool: "AppleScript blocked (grant Accessibility permission)",
        };
  }
  if (os === "linux") {
    if (commandExists("wmctrl")) {
      return { available: true, tool: "wmctrl" };
    }
    if (commandExists("xdotool")) {
      return { available: true, tool: "xdotool" };
    }
    return {
      available: false,
      tool: "none (install wmctrl or xdotool)",
    };
  }
  if (os === "win32") {
    return { available: true, tool: "PowerShell Get-Process" };
  }
  return { available: false, tool: "unsupported platform" };
}

function runCommand(command: string, args: string[], timeout: number): void {
  execFileSync(command, args, {
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runMacScreenshotCommand(args: string[]): void {
  try {
    runCommand("screencapture", args, 10000);
  } catch {
    throw new Error(
      "Screen capture failed. Grant Screen Recording permission to this app or terminal and try again.",
    );
  }
}

function canCaptureMacScreen(): boolean {
  const tmpFile = join(tmpdir(), `desktop-screenshot-probe-${Date.now()}.png`);
  try {
    runCommand("screencapture", ["-x", "-R0,0,1,1", tmpFile], 5000);
    return true;
  } catch {
    return false;
  } finally {
    removeTempFile(tmpFile);
  }
}

function canUseMacSystemEvents(): boolean {
  try {
    execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to count of processes'],
      {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

function removeTempFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Temp cleanup is best effort.
  }
}

function toAppleScriptStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function macKeyCode(keys: string): number | null {
  const symbolicKeyCodes: Record<string, number> = {
    return: 36,
    enter: 36,
    tab: 48,
    space: 49,
    escape: 53,
    esc: 53,
    left: 123,
    right: 124,
    down: 125,
    up: 126,
  };
  const normalized = keys.trim().toLowerCase();
  const mappedCode = symbolicKeyCodes[normalized];
  if (mappedCode !== undefined) {
    return mappedCode;
  }
  const numericCode = Number(keys.trim());
  return Number.isInteger(numericCode) ? numericCode : null;
}

function runPowerShellMouseScript(
  x: number,
  y: number,
  button: DesktopInputButton,
  repeat: number,
): void {
  const downFlag = button === "right" ? "0x0008" : "0x0002";
  const upFlag = button === "right" ? "0x0010" : "0x0004";
  const clicks = Array.from(
    { length: Math.max(1, Math.min(2, repeat)) },
    () =>
      `[Win32.Win32Mouse]::mouse_event(${downFlag}, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(${upFlag}, 0, 0, 0, 0)`,
  ).join("; ");
  const psScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
    `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
    clicks,
  ].join("; ");
  runCommand("powershell", ["-Command", psScript], 5000);
}

function clampScrollDelta(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.trunc(Math.max(-20, Math.min(20, value)));
}

function clickMouseWheel(button: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    runCommand("xdotool", ["click", button], 5000);
  }
}

export function getDesktopPlatformName(): NodeJS.Platform {
  return platform();
}
