/** Verifies the deterministic macOS Chromium Safe Storage lookup boundary. */
import { describe, expect, it, vi } from "vitest";
import { readChromiumSafeStoragePassword } from "./credentials.ts";

function outputProcess(output: string, exitCode = 0, errorOutput = "") {
  const stdout = new Response(output).body;
  const stderr = new Response(errorOutput).body;
  if (!stdout || !stderr) throw new Error("Expected in-memory response bodies");
  return { exited: Promise.resolve(exitCode), kill: vi.fn(), stderr, stdout };
}

describe("readChromiumSafeStoragePassword", () => {
  it("returns the trimmed password from the named macOS Keychain service", async () => {
    const spawn = vi.fn(() => outputProcess("safe-storage-password\n"));

    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        platform: "darwin",
        spawn,
      }),
    ).resolves.toBe("safe-storage-password");
    expect(spawn).toHaveBeenCalledWith([
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      "Chrome Safe Storage",
      "-w",
    ]);
  });

  it("returns null when the Keychain lookup fails", async () => {
    const spawn = vi.fn(() => {
      throw new Error("Keychain unavailable");
    });

    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        platform: "darwin",
        spawn,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a nonzero lookup and an empty password", async () => {
    const failedSpawn = vi.fn(() => outputProcess("ignored", 44));
    const emptySpawn = vi.fn(() => outputProcess("\n"));

    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        platform: "darwin",
        spawn: failedSpawn,
      }),
    ).resolves.toBeNull();
    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        platform: "darwin",
        spawn: emptySpawn,
      }),
    ).resolves.toBeNull();
  });

  it("drains both pipes while the lookup is running", async () => {
    let stdoutRead = false;
    let stderrRead = false;
    const stream = (markRead: () => void) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          markRead();
          controller.close();
        },
      });
    const spawn = vi.fn(() => ({
      exited: Promise.resolve(0),
      kill: vi.fn(),
      stdout: stream(() => {
        stdoutRead = true;
      }),
      stderr: stream(() => {
        stderrRead = true;
      }),
    }));

    await readChromiumSafeStoragePassword("Chrome Safe Storage", {
      platform: "darwin",
      spawn,
    });
    expect(stdoutRead).toBe(true);
    expect(stderrRead).toBe(true);
  });

  it("rejects stdout that exceeds the configured byte cap", async () => {
    const spawn = vi.fn(() => outputProcess("x".repeat(33)));

    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        maxPipeBytes: 32,
        platform: "darwin",
        spawn,
      }),
    ).resolves.toBeNull();
  });

  it("rejects stderr that exceeds the configured byte cap", async () => {
    const spawn = vi.fn(() => outputProcess("password", 0, "x".repeat(33)));

    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        maxPipeBytes: 32,
        platform: "darwin",
        spawn,
      }),
    ).resolves.toBeNull();
  });

  it("cancels an overflowing non-closing pipe and observes process termination", async () => {
    let cancelled = false;
    let resolveExit: ((exitCode: number) => void) | undefined;
    let exitObserved = false;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    void exited.then(() => {
      exitObserved = true;
    });
    const kill = vi.fn((signal?: number | NodeJS.Signals) => {
      if (signal === "SIGTERM") resolveExit?.(143);
    });
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.enqueue(new Uint8Array(17));
      },
      cancel() {
        cancelled = true;
      },
    });
    const stderr = new Response("").body;
    if (!stderr) throw new Error("Expected in-memory response body");
    const spawn = vi.fn(() => ({ exited, kill, stderr, stdout }));

    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        maxPipeBytes: 32,
        platform: "darwin",
        spawn,
        terminationGraceMs: 5,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeNull();
    expect(cancelled).toBe(true);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(exitObserved).toBe(true);
  });

  it("bounds a stuck lookup, terminates it, and observes its exit", async () => {
    let resolveExit: ((exitCode: number) => void) | undefined;
    let exitObserved = false;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    void exited.then(() => {
      exitObserved = true;
    });
    const kill = vi.fn((signal?: number | NodeJS.Signals) => {
      if (signal === "SIGTERM") resolveExit?.(143);
    });
    const stdout = new Response("").body;
    const stderr = new Response("").body;
    if (!stdout || !stderr)
      throw new Error("Expected in-memory response bodies");
    const spawn = vi.fn(() => ({ exited, kill, stderr, stdout }));

    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        platform: "darwin",
        spawn,
        terminationGraceMs: 5,
        timeoutMs: 5,
      }),
    ).resolves.toBeNull();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(exitObserved).toBe(true);
  });

  it("does not spawn a Keychain lookup outside macOS", async () => {
    const spawn = vi.fn(() => outputProcess("must-not-be-read"));

    await expect(
      readChromiumSafeStoragePassword("Chrome Safe Storage", {
        platform: "linux",
        spawn,
      }),
    ).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});
