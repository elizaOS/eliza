import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandMock = vi.fn();

let platform: "darwin" | "linux" | "win32" = "darwin";
let hasCliclick = false;

vi.mock("../platform/helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../platform/helpers.js")>(
    "../platform/helpers.js",
  );

  return {
    ...actual,
    commandExists: vi.fn((command: string) =>
      command === "cliclick" ? hasCliclick : command === "xdotool",
    ),
    currentPlatform: vi.fn(() => platform),
    runCommand: runCommandMock,
  };
});

describe("desktop platform helpers", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    platform = "darwin";
    hasCliclick = false;
  });

  it("maps special macOS single keys to key codes when cliclick is unavailable", async () => {
    const { desktopKeyPress } = await import("../platform/desktop.js");

    desktopKeyPress("ESCAPE");

    expect(runCommandMock).toHaveBeenCalledWith(
      "osascript",
      ["-e", 'tell application "System Events" to key code 53'],
      5000,
    );
  });

  it("maps special macOS combo keys to key codes instead of literal text", async () => {
    const { desktopKeyCombo } = await import("../platform/desktop.js");

    desktopKeyCombo("shift+ESCAPE");

    expect(runCommandMock).toHaveBeenCalledWith(
      "osascript",
      [
        "-e",
        'tell application "System Events" to key code 53 using {shift down}',
      ],
      5000,
    );
  });

  it("normalizes Linux combo keys before calling xdotool", async () => {
    const { desktopKeyCombo } = await import("../platform/desktop.js");
    platform = "linux";

    desktopKeyCombo("ctrl+ESCAPE");

    expect(runCommandMock).toHaveBeenCalledWith(
      "xdotool",
      ["key", "ctrl+Escape"],
      5000,
    );
  });

  it("normalizes Windows combo keys before calling SendKeys", async () => {
    const { desktopKeyCombo } = await import("../platform/desktop.js");
    platform = "win32";

    desktopKeyCombo("ctrl+ESCAPE");

    expect(runCommandMock).toHaveBeenCalledWith(
      "powershell",
      [
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^{ESC}')",
      ],
      5000,
    );
  });

  it("uses the macOS CoreGraphics fallback for mouse movement when cliclick is unavailable", async () => {
    const { desktopMouseMove } = await import("../platform/desktop.js");

    desktopMouseMove(10, 20);

    expect(runCommandMock).toHaveBeenCalledWith(
      "osascript",
      expect.arrayContaining(["-l", "JavaScript"]),
      5000,
    );
    expect(runCommandMock.mock.calls[0]?.[1]?.[3]).toContain(
      "kCGEventMouseMoved",
    );
  });

  it("uses the macOS CoreGraphics fallback for scrolling and clamps the amount", async () => {
    const { desktopScroll } = await import("../platform/desktop.js");

    desktopScroll(10, 20, "down", 30);

    expect(runCommandMock).toHaveBeenCalledWith(
      "osascript",
      expect.arrayContaining(["-l", "JavaScript"]),
      5000,
    );
    expect(runCommandMock.mock.calls[0]?.[1]?.[3]).toContain(
      "CGEventCreateScrollWheelEvent",
    );
    expect(runCommandMock.mock.calls[0]?.[1]?.[3]).toContain("-20");
  });
});
