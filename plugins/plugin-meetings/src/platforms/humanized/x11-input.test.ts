import { afterEach, describe, expect, it, vi } from "vitest";
import { X11Input } from "./x11-input";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  default: { execFile: vi.fn() },
}));

describe("X11Input (dryRun command recording)", () => {
  it("defaults the display to :99 when neither option nor env is set", () => {
    delete process.env.DISPLAY;
    const input = new X11Input({ dryRun: true });
    // Exercise isAvailable (dryRun short-circuits to true) and moveAbs to
    // confirm the recorded argv carries the defaulted display-independent
    // command shape.
    expect(input.isAvailable()).resolves.toBe(true);
    return input.moveAbs(1, 1);
  });

  it("records argv lines and tracks the simulated pointer in dryRun", async () => {
    const input = new X11Input({ dryRun: true, display: ":9" });
    await input.moveAbs(100, 200);
    await input.moveRel(-30, 40);
    const pointer = await input.getPointer();

    expect(input.log).toEqual([
      ["xdotool", "mousemove", "--sync", "--", "100", "200"],
      ["xdotool", "mousemove_relative", "--sync", "--", "-30", "40"],
    ]);
    expect(pointer).toEqual({ x: 70, y: 240 });
  });

  it("uses an option terminator before negative absolute coordinates", async () => {
    // Without the "--" terminator, xdotool would parse "-100" as an option
    // and fail the move; moveRel already terminates, moveAbs must too.
    const input = new X11Input({ dryRun: true, display: ":9" });
    await input.moveAbs(-100, -50);
    expect(input.log[0]).toEqual([
      "xdotool",
      "mousemove",
      "--sync",
      "--",
      "-100",
      "-50",
    ]);
  });

  it("does not let getPointer mutate the simulated pointer", async () => {
    const input = new X11Input({ dryRun: true, display: ":9" });
    await input.moveAbs(5, 6);
    const first = await input.getPointer();
    first.x = 999;
    expect(await input.getPointer()).toEqual({ x: 5, y: 6 });
  });

  it("records mouse button presses with default and explicit buttons", async () => {
    const input = new X11Input({ dryRun: true, display: ":9" });
    await input.buttonDown();
    await input.buttonUp(3);
    expect(input.log).toEqual([
      ["xdotool", "mousedown", "1"],
      ["xdotool", "mouseup", "3"],
    ]);
  });

  it("records typeText with delay and clear-modifiers flags", async () => {
    const input = new X11Input({ dryRun: true, display: ":9" });
    await input.typeText("hello world", 120);
    expect(input.log[0]).toEqual([
      "xdotool",
      "type",
      "--clearmodifiers",
      "--delay",
      "120",
      "--",
      "hello world",
    ]);
  });

  it("short-circuits isAvailable to true in dryRun", async () => {
    const input = new X11Input({ dryRun: true, display: ":9" });
    await expect(input.isAvailable()).resolves.toBe(true);
    expect(input.log).toEqual([]);
  });

  it("returns false from isAvailable when no display is configured", async () => {
    delete process.env.DISPLAY;
    const input = new X11Input({ dryRun: false, display: "" });
    await expect(input.isAvailable()).resolves.toBe(false);
  });
});

describe("X11Input (live execFile path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects when xdotool is missing", async () => {
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
      cb?.(new Error("xdotool not found"), "");
    });
    const input = new X11Input({ dryRun: false, display: ":9" });
    await expect(input.isAvailable()).resolves.toBe(false);
  });

  it("parses getmouselocation --shell output", async () => {
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
      cb?.(null, "X=1200\nY=800\nSCREEN=0");
    });
    const input = new X11Input({ dryRun: false, display: ":9" });
    await expect(input.getPointer()).resolves.toEqual({ x: 1200, y: 800 });
  });

  it("passes the display override through the execFile env", async () => {
    const { execFile } = await import("node:child_process");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    vi.mocked(execFile).mockImplementation((_cmd, _args, opts, cb) => {
      capturedEnv = (opts as { env: NodeJS.ProcessEnv }).env;
      cb?.(null, "");
    });
    const input = new X11Input({ dryRun: false, display: ":77" });
    await input.moveAbs(1, 2);
    expect(capturedEnv?.DISPLAY).toBe(":77");
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "xdotool",
      ["mousemove", "--sync", "--", "1", "2"],
      expect.objectContaining({ env: expect.any(Object) }),
      expect.any(Function),
    );
  });
});
