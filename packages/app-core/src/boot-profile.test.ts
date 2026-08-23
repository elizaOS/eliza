/**
 * Unit coverage for the boot profiler's enable gate. Deterministic and
 * dependency-free: the module reads `ELIZA_BOOT_PROFILE` once at evaluation
 * time, so each case sets the environment and re-imports through a fresh
 * module registry rather than mocking the module itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "ELIZA_BOOT_PROFILE";

async function loadBootProfile(enabled: boolean) {
  const previous = process.env[ENV_KEY];
  if (enabled) {
    process.env[ENV_KEY] = "1";
  } else {
    delete process.env[ENV_KEY];
  }
  vi.resetModules();
  try {
    return await import("./boot-profile.ts");
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
}

describe("boot-profile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reports disabled when ELIZA_BOOT_PROFILE is unset", async () => {
    const mod = await loadBootProfile(false);
    expect(mod.bootProfileEnabled()).toBe(false);
  });

  it("reports enabled when ELIZA_BOOT_PROFILE=1", async () => {
    const mod = await loadBootProfile(true);
    expect(mod.bootProfileEnabled()).toBe(true);
  });

  it("bootLap writes nothing while disabled", async () => {
    const mod = await loadBootProfile(false);
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    mod.bootLap("startEliza:before-api");
    expect(write).not.toHaveBeenCalled();
  });

  it("bootLap writes a labelled lap line while enabled", async () => {
    const mod = await loadBootProfile(true);
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    mod.bootLap("startEliza:before-api");
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toContain("[boot-profile]");
    expect(line).toContain("startEliza:before-api");
    expect(line).toMatch(/\+\d+ms \(Δ\d+ms\)\n$/);
  });
});
