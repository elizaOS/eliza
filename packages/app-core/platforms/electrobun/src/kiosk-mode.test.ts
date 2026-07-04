/** Exercises kiosk mode behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  appendKioskShellModeParam,
  appendShellModeParam,
  isKioskShellMode,
  readRendererShellMode,
} from "./kiosk-mode";

describe("electrobun shell mode", () => {
  it("reads supported renderer shell modes from env and argv", () => {
    expect(
      readRendererShellMode({ ELIZAOS_SHELL_MODE: "voice-selftest" }, []),
    ).toBe("voice-selftest");
    expect(readRendererShellMode({}, ["--shell-mode=voice-workbench"])).toBe(
      "voice-workbench",
    );
  });

  it("ignores unsupported renderer shell modes", () => {
    expect(readRendererShellMode({ ELIZAOS_SHELL_MODE: "surprise" }, [])).toBe(
      null,
    );
    expect(readRendererShellMode({}, ["--shell-mode=surprise"])).toBe(null);
  });

  it("keeps kiosk detection on the shared shell-mode reader", () => {
    expect(isKioskShellMode({ ELIZAOS_SHELL_MODE: "kiosk" }, [])).toBe(true);
    expect(isKioskShellMode({}, ["--shell-mode=kiosk"])).toBe(true);
    expect(isKioskShellMode({ ELIZAOS_SHELL_MODE: "voice-selftest" }, [])).toBe(
      false,
    );
  });

  it("appends arbitrary renderer shell modes while preserving query and hash", () => {
    expect(
      appendShellModeParam(
        "http://localhost:2138/?foo=1#/chat",
        "voice-selftest",
      ),
    ).toBe("http://localhost:2138/?foo=1&shellMode=voice-selftest#/chat");
  });

  it("keeps the kiosk-specific wrapper behavior", () => {
    expect(appendKioskShellModeParam("not a url")).toBe(
      "not a url?shellMode=kiosk",
    );
  });
});
