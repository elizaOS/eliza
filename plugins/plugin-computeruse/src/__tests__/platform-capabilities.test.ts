import { describe, expect, it } from "vitest";
import { detectPlatformCapabilities } from "../platform/capabilities.js";
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
