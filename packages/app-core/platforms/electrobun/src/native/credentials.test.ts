/** Verifies the deterministic macOS Chromium Safe Storage lookup boundary. */
import { describe, expect, it, vi } from "vitest";
import { readChromiumSafeStoragePassword } from "./credentials.ts";

function outputProcess(output: string, exitCode = 0) {
  const stdout = new Response(output).body;
  if (!stdout) throw new Error("Expected an in-memory response body");
  return { exited: Promise.resolve(exitCode), stdout };
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
      "security",
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
