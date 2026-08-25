/**
 * Unit tests for boot profile timing and lap logger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("boot-profile", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("disables profiling and suppresses stderr logs when ELIZA_BOOT_PROFILE is unset", async () => {
    delete process.env.ELIZA_BOOT_PROFILE;
    delete process.env.ELIZA_API_PROCESS_SPAWNED_AT_MS;
    delete process.env.ELIZA_PROCESS_SPAWNED_AT_MS;

    const { bootLap, bootProfileEnabled } = await import("./boot-profile.js");

    expect(bootProfileEnabled()).toBe(false);

    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    bootLap("start:test");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("falls back to ELIZA_PROCESS_SPAWNED_AT_MS when API spawn key is absent", async () => {
    const spawnTime = Date.now() - 100;
    delete process.env.ELIZA_API_PROCESS_SPAWNED_AT_MS;
    process.env.ELIZA_PROCESS_SPAWNED_AT_MS = String(spawnTime);
    process.env.ELIZA_BOOT_PROFILE = "1";

    const { bootLap } = await import("./boot-profile.js");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    bootLap("fallback:spawn");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("[boot-profile]");
    expect(writes[0]).toMatch(/\+\d+ms/);
  });

  it("disables profiling when ELIZA_BOOT_PROFILE is not exactly '1'", async () => {
    delete process.env.ELIZA_API_PROCESS_SPAWNED_AT_MS;
    delete process.env.ELIZA_PROCESS_SPAWNED_AT_MS;
    process.env.ELIZA_BOOT_PROFILE = "true";

    const { bootLap, bootProfileEnabled } = await import("./boot-profile.js");
    expect(bootProfileEnabled()).toBe(false);
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    bootLap("should-not-log");
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps lastLap delta growing across successive laps", async () => {
    const spawnTime = Date.now() - 200;
    process.env.ELIZA_BOOT_PROFILE = "1";
    process.env.ELIZA_API_PROCESS_SPAWNED_AT_MS = String(spawnTime);

    const { bootLap } = await import("./boot-profile.js");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    bootLap("first");
    await new Promise((r) => setTimeout(r, 5));
    bootLap("second");
    expect(writes).toHaveLength(2);
    // second lap Δ should be >0 and sinceSpawn larger than first
    const firstSince = Number(writes[0].match(/\+(\d+)ms/)?.[1]);
    const secondSince = Number(writes[1].match(/\+(\d+)ms/)?.[1]);
    expect(secondSince).toBeGreaterThanOrEqual(firstSince);
  });

  it("enables profiling and writes formatted elapsed times to stderr when ELIZA_BOOT_PROFILE is 1", async () => {
    const spawnTime = Date.now() - 50;
    process.env.ELIZA_BOOT_PROFILE = "1";
    process.env.ELIZA_API_PROCESS_SPAWNED_AT_MS = String(spawnTime);

    const { bootLap, bootProfileEnabled } = await import("./boot-profile.js");

    expect(bootProfileEnabled()).toBe(true);

    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    bootLap("init:config");
    bootLap("start:api");

    expect(writes).toHaveLength(2);

    expect(writes[0]).toContain("[boot-profile]");
    expect(writes[0]).toContain("init:config".padEnd(40));
    expect(writes[0]).toMatch(/\+\d+ms/);
    expect(writes[0]).toMatch(/\(\u0394\d+ms\)/);

    expect(writes[1]).toContain("[boot-profile]");
    expect(writes[1]).toContain("start:api".padEnd(40));
    expect(writes[1]).toMatch(/\+\d+ms/);
    expect(writes[1]).toMatch(/\(\u0394\d+ms\)/);
  });
});
