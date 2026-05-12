import type { PlatformCapabilities } from "../types.js";
import type { PlatformOS } from "./helpers.js";

export interface CapabilityDetectionOptions {
  osName: PlatformOS;
  commandExists: (command: string) => boolean;
  isBrowserAvailable: () => boolean;
  shell?: string;
}

export function detectPlatformCapabilities(
  options: CapabilityDetectionOptions,
): PlatformCapabilities {
  const caps: PlatformCapabilities = {
    screenshot: { available: false, tool: "none" },
    computerUse: { available: false, tool: "none" },
    windowList: { available: false, tool: "none" },
    browser: { available: false, tool: "none" },
    terminal: { available: false, tool: "none" },
    fileSystem: { available: true, tool: "node:fs" },
  };

  if (options.osName === "darwin") {
    caps.screenshot = { available: true, tool: "screencapture (built-in)" };
    caps.computerUse = options.commandExists("cliclick")
      ? { available: true, tool: "cliclick" }
      : {
          available: true,
          tool: "AppleScript / Swift fallbacks (mouse_move requires cliclick)",
        };
    caps.windowList = {
      available: true,
      tool: "AppleScript System Events",
    };
  } else if (options.osName === "linux") {
    if (options.commandExists("import")) {
      caps.screenshot = { available: true, tool: "ImageMagick import" };
    } else if (options.commandExists("scrot")) {
      caps.screenshot = { available: true, tool: "scrot" };
    } else if (options.commandExists("gnome-screenshot")) {
      caps.screenshot = { available: true, tool: "gnome-screenshot" };
    } else {
      caps.screenshot = {
        available: false,
        tool: "none (install ImageMagick, scrot, or gnome-screenshot)",
      };
    }

    caps.computerUse = options.commandExists("xdotool")
      ? { available: true, tool: "xdotool" }
      : { available: false, tool: "none (install xdotool)" };

    if (options.commandExists("wmctrl")) {
      caps.windowList = { available: true, tool: "wmctrl" };
    } else if (options.commandExists("xdotool")) {
      caps.windowList = { available: true, tool: "xdotool" };
    } else {
      caps.windowList = {
        available: false,
        tool: "none (install wmctrl or xdotool)",
      };
    }
  } else if (options.osName === "win32") {
    caps.screenshot = { available: true, tool: "PowerShell System.Drawing" };
    caps.computerUse = { available: true, tool: "PowerShell user32.dll" };
    caps.windowList = { available: true, tool: "PowerShell Get-Process" };
  }

  caps.browser = options.isBrowserAvailable()
    ? { available: true, tool: "puppeteer-core (Chromium detected)" }
    : { available: false, tool: "none (no Chrome/Edge/Brave found)" };

  caps.terminal =
    options.osName === "win32"
      ? { available: true, tool: "powershell.exe" }
      : options.commandExists(options.shell ?? "/bin/bash")
        ? { available: true, tool: options.shell ?? "/bin/bash" }
        : { available: true, tool: options.shell ?? "/bin/sh" };

  return caps;
}
