import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDesktopRunner,
  buildAgentDesktopEnv,
  buildScreenshotPath,
  computerClick,
  computerLaunch,
  computerScreenshot,
  computerSnapshot,
  computerType,
} from "./computer";

describe("computer tools", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores screenshots under .grok/computer by default", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-computer-"));
    tempDirs.push(cwd);

    const outputPath = buildScreenshotPath(cwd);

    expect(outputPath).toContain(path.join(".grok", "computer"));
    expect(path.dirname(outputPath)).toBe(path.join(cwd, ".grok", "computer"));
  });

  it("captures screenshots through agent-desktop", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-computer-"));
    tempDirs.push(cwd);
    const outputPath = path.join(cwd, "artifacts", "screen.png");
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({ ok: true, command: "screenshot", data: { path: outputPath } }),
      stderr: "",
    }));

    const result = await computerScreenshot(
      { output_path: "artifacts/screen.png", app: "Google Chrome", window_id: "w-42" },
      cwd,
      undefined,
      runner,
    );

    expect(result.success).toBe(true);
    expect(result.media).toEqual([{ kind: "image", path: outputPath, mediaType: "image/png" }]);
    expect(result.computer).toEqual({
      action: "screenshot",
      path: outputPath,
      app: "Google Chrome",
      windowId: "w-42",
      hint: "Use computer_snapshot to inspect accessibility refs before clicking or typing.",
    });
    expect(runner).toHaveBeenCalledWith(
      ["screenshot", outputPath, "--app", "Google Chrome", "--window-id", "w-42"],
      cwd,
      undefined,
    );
  });

  it("formats snapshots with refs and raw JSON", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({
        ok: true,
        command: "snapshot",
        data: {
          refs: ["@e1", "@e2"],
        },
      }),
      stderr: "",
    }));

    const result = await computerSnapshot({ app: "Finder" }, "/tmp", undefined, runner);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Refs: @e1, @e2");
    expect(result.output).toContain('"command": "snapshot"');
    expect(result.computer).toEqual({
      action: "snapshot",
      app: "Finder",
      windowId: undefined,
    });
    expect(runner).toHaveBeenCalledWith(["snapshot", "--app", "Finder", "--interactive-only"], "/tmp", undefined);
  });

  it("clicks by accessibility ref", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({ ok: true, command: "click", data: { action: "click" } }),
      stderr: "",
    }));

    const result = await computerClick({ ref: "@e7" }, "/tmp", undefined, runner);

    expect(result.success).toBe(true);
    expect(result.computer).toEqual({ action: "click", ref: "@e7" });
    expect(runner).toHaveBeenCalledWith(["click", "@e7"], "/tmp", undefined);
  });

  it("reports a specific error for non-left ref clicks", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: "",
      stderr: "",
    }));

    const result = await computerClick({ ref: "@e7", button: "right" }, "/tmp", undefined, runner);

    expect(result.success).toBe(false);
    expect(result.output).toContain("supports only the left button");
    expect(runner).not.toHaveBeenCalled();
  });

  it("types into an element ref", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({ ok: true, command: "type", data: { action: "type" } }),
      stderr: "",
    }));

    const result = await computerType({ ref: "@e5", text: "hello from grok" }, "/tmp", undefined, runner);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Typed into @e5.");
    expect(runner).toHaveBeenCalledWith(["type", "@e5", "hello from grok"], "/tmp", undefined);
  });

  it("launches apps through agent-desktop", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({ ok: true, command: "launch", data: { launched: true } }),
      stderr: "",
    }));

    const result = await computerLaunch({ app: "Google Chrome", timeout_ms: 15000 }, "/tmp", undefined, runner);

    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(["launch", "Google Chrome", "--timeout", "15000"], "/tmp", undefined);
  });

  it("adds a macOS accessibility hint on permission failures", async () => {
    const runner: AgentDesktopRunner = vi.fn(async () => ({
      success: false,
      stdout: JSON.stringify({
        ok: false,
        command: "snapshot",
        error: {
          code: "PERM_DENIED",
          message: "Accessibility permission not granted",
          suggestion: "Open System Settings > Privacy & Security > Accessibility and add your terminal application",
        },
      }),
      stderr: "",
    }));

    const result = await computerSnapshot({ app: "Finder" }, "/tmp", undefined, runner);

    expect(result.success).toBe(false);
    expect(result.output).toContain("Accessibility permission");
  });

  it("only forwards an allowlisted environment to agent-desktop", () => {
    const env = buildAgentDesktopEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/tester",
      TERM: "xterm-256color",
      GROK_API_KEY: "secret",
      TELEGRAM_BOT_TOKEN: "also-secret",
      CUSTOM_SECRET: "nope",
    });

    expect(env).toEqual({
      FORCE_COLOR: "0",
      HOME: "/Users/tester",
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
    });
  });
});
