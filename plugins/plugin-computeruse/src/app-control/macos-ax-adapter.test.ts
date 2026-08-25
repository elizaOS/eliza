import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  default: { spawn: mocks.spawn },
  spawn: mocks.spawn,
}));
vi.mock("node:fs", () => ({
  default: { existsSync: mocks.existsSync },
  existsSync: mocks.existsSync,
}));

import { MacosAxAdapter, resolveMacosAxHelper } from "./macos-ax-adapter";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function emitOk(child: ReturnType<typeof makeChild>, result: unknown) {
  child.stdout.emit("data", Buffer.from(JSON.stringify({ ok: true, result })));
  child.emit("close", 0);
}

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  vi.unstubAllEnvs();
  vi.useRealTimers();
  mocks.spawn.mockReset();
  mocks.existsSync.mockReset();
});

describe("resolveMacosAxHelper", () => {
  it("returns null on non-macOS platforms regardless of files", () => {
    setPlatform("linux");
    mocks.existsSync.mockReturnValue(true);
    expect(resolveMacosAxHelper()).toBeNull();
    expect(mocks.existsSync).not.toHaveBeenCalled();
  });

  it("returns the trimmed env override when it exists", () => {
    setPlatform("darwin");
    vi.stubEnv("ELIZA_COMPUTERUSE_MACOS_AX_HELPER", "  /custom/helper  ");
    mocks.existsSync.mockImplementation((p: string) => p === "/custom/helper");
    expect(resolveMacosAxHelper()).toBe("/custom/helper");
  });

  it("falls back to packaged candidates when the env override is blank", () => {
    setPlatform("darwin");
    vi.stubEnv("ELIZA_COMPUTERUSE_MACOS_AX_HELPER", "   ");
    mocks.existsSync.mockReturnValue(false);
    expect(resolveMacosAxHelper()).toBeNull();
  });

  it("returns the first existing packaged candidate", () => {
    setPlatform("darwin");
    mocks.existsSync.mockImplementation((p: string) =>
      p.includes("native/macos-ax-helper"),
    );
    const resolved = resolveMacosAxHelper();
    expect(resolved).not.toBeNull();
    expect(resolved).toMatch(/macos-ax-helper$/);
  });

  it("returns null when no candidate exists", () => {
    setPlatform("darwin");
    mocks.existsSync.mockReturnValue(false);
    expect(resolveMacosAxHelper()).toBeNull();
  });

  it("reports availability through the adapter contract", () => {
    setPlatform("darwin");
    mocks.existsSync.mockReturnValue(true);
    expect(new MacosAxAdapter().available()).toBe(true);
    mocks.existsSync.mockReturnValue(false);
    expect(new MacosAxAdapter().available()).toBe(false);
  });
});

describe("MacosAxAdapter bounded helper protocol", () => {
  beforeEach(() => {
    setPlatform("darwin");
    mocks.existsSync.mockReturnValue(true);
  });

  it("resolves the typed result from a well-formed helper response", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = new MacosAxAdapter().listApps();
    emitOk(child, [{ id: "com.apple.Safari", name: "Safari" }]);
    await expect(promise).resolves.toEqual([
      { id: "com.apple.Safari", name: "Safari" },
    ]);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(child.stdin.end).toHaveBeenCalledWith(
      JSON.stringify({ command: "list_apps" }),
    );
  });

  it("forwards action request fields to the helper payload", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = new MacosAxAdapter().perform(
      { id: "app-1", name: "App", pid: 1, active: true },
      { role: "button", label: "OK", locator: "l1" },
      { kind: "click", text: "hello", modifiers: ["shift"] },
    );
    emitOk(child, { done: true });
    await expect(promise).resolves.toEqual({ done: true });
    const payload = JSON.parse(
      (child.stdin.end as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );
    expect(payload).toMatchObject({
      command: "perform",
      app: "app-1",
      action: "click",
      locator: "l1",
      expected: { role: "button", label: "OK" },
      text: "hello",
      modifiers: ["shift"],
    });
  });

  it("rejects with the helper message when the response reports a failure", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = new MacosAxAdapter().listApps();
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: false,
          error: { code: "E_ACCESS", message: "denied" },
        }),
      ),
    );
    child.emit("close", 1);
    await expect(promise).rejects.toThrow("denied");
  });

  it("falls back to the error code when no message is present", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = new MacosAxAdapter().listApps();
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ ok: false, error: { code: "E_ACCESS" } })),
    );
    child.emit("close", 1);
    await expect(promise).rejects.toThrow("E_ACCESS");
  });

  it("classifies invalid helper JSON with a non-zero exit using the stderr diagnostic", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = new MacosAxAdapter().listApps();
    child.stdout.emit("data", Buffer.from("not json"));
    child.stderr.emit("data", Buffer.from("boom\n"));
    child.emit("close", 3);
    await expect(promise).rejects.toThrow(
      "macOS AX helper failed with exit 3: boom",
    );
  });

  it("surfaces the parse error when invalid JSON exits zero", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = new MacosAxAdapter().listApps();
    child.stdout.emit("data", Buffer.from("not json"));
    child.emit("close", 0);
    await expect(promise).rejects.toThrow();
  });

  it("kills the helper with SIGKILL when the 10 second boundary elapses", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = new MacosAxAdapter().listApps();
    const assertion = expect(promise).rejects.toThrow(
      "macOS AX helper exceeded its 10 second boundary",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await assertion;
  });

  it("kills the helper with SIGKILL on caller abort", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const promise = new MacosAxAdapter().listApps(controller.signal);
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(promise).rejects.toThrow("macOS AX helper call cancelled");
  });

  it("kills the helper with SIGKILL when output exceeds 32 MiB", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const promise = new MacosAxAdapter().listApps();
    child.stdout.emit("data", Buffer.alloc(32 * 1024 * 1024 + 1));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(promise).rejects.toThrow(
      "macOS AX helper response exceeded 32 MiB",
    );
  });

  it("fails loud when the helper binary cannot be resolved", async () => {
    mocks.existsSync.mockReturnValue(false);
    setPlatform("darwin");
    await expect(new MacosAxAdapter().listApps()).rejects.toThrow(
      "Packaged macOS AX helper is unavailable",
    );
  });
});
