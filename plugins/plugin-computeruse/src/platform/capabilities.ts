import type { PlatformCapabilities } from "../types.js";
import type { PlatformOS } from "./helpers.js";

export interface CapabilityDetectionOptions {
  osName: PlatformOS;
  commandExists: (command: string) => boolean;
  isBrowserAvailable: () => boolean;
  shell?: string;
}

/**
 * Per-capability parity classification, kept in lock-step with
 * `plugins/plugin-computeruse/src/mobile/parity-status.md`.
 *
 *   verified         — exercised on real hardware (Linux/macOS in CI today)
 *   code-parity      — feature-equivalent code path exists, runtime untested
 *   stub             — surface present but no real implementation
 *   blocked          — OS does not allow the operation in our delivery model
 *
 * iOS / Android live in `mobile/parity-status.md`; they are not desktop OSes
 * and don't pass through `detectPlatformCapabilities`.
 */
export type ParityStatus = "verified" | "code-parity" | "stub" | "blocked";

export interface ParityNote {
  readonly status: ParityStatus;
  readonly note?: string;
}

/**
 * Static parity table for desktop targets, derived from the per-file audit.
 * Linux is the reference implementation.
 */
export const DESKTOP_PARITY: Readonly<
  Record<PlatformOS, Readonly<Record<keyof PlatformCapabilities, ParityNote>>>
> = {
  linux: {
    screenshot: { status: "verified" },
    computerUse: { status: "verified" },
    windowList: { status: "verified" },
    browser: { status: "verified" },
    terminal: { status: "verified" },
    fileSystem: { status: "verified" },
    clipboard: { status: "verified", note: "wl-clipboard / xclip / xsel" },
  },
  darwin: {
    screenshot: { status: "code-parity", note: "screencapture (built-in)" },
    computerUse: {
      status: "code-parity",
      note: "cliclick + AppleScript / Swift fallbacks",
    },
    windowList: { status: "code-parity", note: "AppleScript System Events" },
    browser: {
      status: "code-parity",
      note: "Chrome / Edge / Brave / Brave Beta / Arc / Vivaldi detection",
    },
    terminal: { status: "code-parity", note: "/bin/bash via execFile" },
    fileSystem: { status: "verified" },
    clipboard: { status: "code-parity", note: "pbpaste / pbcopy (built-in)" },
  },
  win32: {
    screenshot: { status: "code-parity", note: "PowerShell System.Drawing" },
    computerUse: { status: "code-parity", note: "PowerShell user32.dll" },
    windowList: {
      status: "code-parity",
      note: "PowerShell Get-Process MainWindowTitle + ProcessName",
    },
    browser: {
      status: "code-parity",
      note: "Chrome / Edge / Brave / Arc / Vivaldi detection",
    },
    terminal: {
      status: "code-parity",
      note: "powershell.exe -NoProfile -Command + Win-specific blocklist",
    },
    fileSystem: { status: "verified" },
    clipboard: { status: "code-parity", note: "PowerShell Get-Clipboard" },
  },
};

export function parityFor(
  osName: PlatformOS,
  capability: keyof PlatformCapabilities,
): ParityNote {
  return DESKTOP_PARITY[osName][capability];
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
    clipboard: { available: false, tool: "none" },
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
    caps.clipboard = { available: true, tool: "pbpaste / pbcopy (built-in)" };
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

    if (options.commandExists("wl-paste")) {
      caps.clipboard = { available: true, tool: "wl-clipboard" };
    } else if (options.commandExists("xclip")) {
      caps.clipboard = { available: true, tool: "xclip" };
    } else if (options.commandExists("xsel")) {
      caps.clipboard = { available: true, tool: "xsel" };
    } else {
      caps.clipboard = {
        available: false,
        tool: "none (install wl-clipboard, xclip, or xsel)",
      };
    }
  } else if (options.osName === "win32") {
    caps.screenshot = { available: true, tool: "PowerShell System.Drawing" };
    caps.computerUse = { available: true, tool: "PowerShell user32.dll" };
    caps.windowList = { available: true, tool: "PowerShell Get-Process" };
    caps.clipboard = { available: true, tool: "PowerShell Get-Clipboard" };
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
