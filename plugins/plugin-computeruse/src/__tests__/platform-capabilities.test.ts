import { describe, expect, it } from "vitest";
import {
  DESKTOP_PARITY,
  detectPlatformCapabilities,
  parityFor,
} from "../platform/capabilities.js";
import type { PlatformOS } from "../platform/helpers.js";

function detectFor(
  osName: PlatformOS,
  availableCommands: string[],
  browserAvailable = true,
) {
  const commands = new Set(availableCommands);
  return detectPlatformCapabilities({
    osName,
    commandExists: (command) => commands.has(command),
    isBrowserAvailable: () => browserAvailable,
    shell: "/bin/zsh",
  });
}

describe("cross-platform computer-use capabilities", () => {
  it("reports macOS desktop control through built-ins plus cliclick when installed", () => {
    const caps = detectFor("darwin", ["cliclick", "/bin/zsh"]);

    expect(caps.screenshot).toMatchObject({
      available: true,
      tool: "screencapture (built-in)",
    });
    expect(caps.computerUse).toMatchObject({
      available: true,
      tool: "cliclick",
    });
    expect(caps.windowList.available).toBe(true);
    expect(caps.fileSystem.available).toBe(true);
    expect(caps.browser.available).toBe(true);
  });

  it("reports Linux desktop control through xdotool and screenshot tools", () => {
    const caps = detectFor("linux", ["xdotool", "scrot", "wmctrl", "/bin/zsh"]);

    expect(caps.screenshot).toMatchObject({
      available: true,
      tool: "scrot",
    });
    expect(caps.computerUse).toMatchObject({
      available: true,
      tool: "xdotool",
    });
    expect(caps.windowList).toMatchObject({
      available: true,
      tool: "wmctrl",
    });
    expect(caps.terminal).toMatchObject({
      available: true,
      tool: "/bin/zsh",
    });
  });

  it("reports Windows desktop control through built-in PowerShell capabilities", () => {
    const caps = detectFor("win32", [], false);

    expect(caps.screenshot).toMatchObject({
      available: true,
      tool: "PowerShell System.Drawing",
    });
    expect(caps.computerUse).toMatchObject({
      available: true,
      tool: "PowerShell user32.dll",
    });
    expect(caps.windowList).toMatchObject({
      available: true,
      tool: "PowerShell Get-Process",
    });
    expect(caps.terminal).toMatchObject({
      available: true,
      tool: "powershell.exe",
    });
    expect(caps.browser.available).toBe(false);
    expect(caps.fileSystem.available).toBe(true);
  });

  it("keeps Linux explicit about missing desktop dependencies", () => {
    const caps = detectFor("linux", ["/bin/zsh"], false);

    expect(caps.screenshot).toMatchObject({
      available: false,
      tool: "none (install ImageMagick, scrot, or gnome-screenshot)",
    });
    expect(caps.computerUse).toMatchObject({
      available: false,
      tool: "none (install xdotool)",
    });
    expect(caps.windowList.available).toBe(false);
    expect(caps.browser.available).toBe(false);
  });
});

describe("desktop parity matrix", () => {
  it("Linux is the verified reference for every capability", () => {
    for (const cap of Object.keys(DESKTOP_PARITY.linux) as Array<
      keyof typeof DESKTOP_PARITY.linux
    >) {
      expect(parityFor("linux", cap).status).toBe("verified");
    }
  });

  it("macOS and Windows declare code-parity for the desktop-control surface", () => {
    for (const cap of [
      "screenshot",
      "computerUse",
      "windowList",
      "browser",
      "terminal",
    ] as const) {
      expect(parityFor("darwin", cap).status).toBe("code-parity");
      expect(parityFor("win32", cap).status).toBe("code-parity");
    }
  });

  it("fileSystem is verified everywhere — pure node:fs", () => {
    expect(parityFor("linux", "fileSystem").status).toBe("verified");
    expect(parityFor("darwin", "fileSystem").status).toBe("verified");
    expect(parityFor("win32", "fileSystem").status).toBe("verified");
  });
});
