import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  probeBinaryAvailable,
  resolveNodeInstallRunner,
  withInstallLock,
} from "./ffmpeg-binaries.ts";

describe("resolveNodeInstallRunner", () => {
  it("keeps the current executable when already running under Node", () => {
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "/opt/node/bin/node",
      }),
    ).toBe("/opt/node/bin/node");
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "C:\\Program Files\\nodejs\\node.exe",
      }),
    ).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("uses node from PATH when invoked under Bun", () => {
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("node");
  });

  it("honors an explicit Node binary override", () => {
    expect(
      resolveNodeInstallRunner({
        env: { ELIZA_NODE_BIN: "/custom/node" },
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("/custom/node");
    expect(
      resolveNodeInstallRunner({
        env: { NODE_BINARY: "/toolchain/node" },
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("/toolchain/node");
  });
});

describe("probeBinaryAvailable", () => {
  it("retries transient ETXTBSY probe failures until the writer closes", async () => {
    let calls = 0;
    const result = await probeBinaryAvailable("fake-ffmpeg", async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("spawn ETXTBSY"), { code: "ETXTBSY" });
      }
    });
    expect(result.available).toBe(true);
    expect(calls).toBe(3);
  });

  it("reports honest unavailability when the transient window never clears", async () => {
    const result = await probeBinaryAvailable("fake-ffmpeg", async () => {
      throw Object.assign(new Error("spawn ETXTBSY"), { code: "ETXTBSY" });
    });
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain("fake-ffmpeg -version failed");
      expect(result.reason).toContain("ETXTBSY");
    }
  }, 15_000);

  it("does not retry a missing binary", async () => {
    let calls = 0;
    const result = await probeBinaryAvailable("fake-ffmpeg", async () => {
      calls += 1;
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });
    expect(result.available).toBe(false);
    if (!result.available)
      expect(result.reason).toBe("fake-ffmpeg not installed");
    expect(calls).toBe(1);
  });

  it("fails fast on non-transient probe errors", async () => {
    let calls = 0;
    const result = await probeBinaryAvailable("fake-ffmpeg", async () => {
      calls += 1;
      throw Object.assign(new Error("exit 1"), { code: 1 });
    });
    expect(result.available).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("withInstallLock", () => {
  it("serializes concurrent critical sections instead of overlapping them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ffmpeg-lock-"));
    const lockDir = join(dir, "install-lock");
    let inside = 0;
    let maxInside = 0;
    const section = async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inside -= 1;
      return maxInside;
    };
    try {
      await Promise.all([
        withInstallLock(lockDir, section, { pollMs: 10 }),
        withInstallLock(lockDir, section, { pollMs: 10 }),
        withInstallLock(lockDir, section, { pollMs: 10 }),
      ]);
      expect(maxInside).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock left behind by a crashed holder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ffmpeg-lock-"));
    const lockDir = join(dir, "install-lock");
    const { mkdirSync, utimesSync } = await import("node:fs");
    mkdirSync(lockDir);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);
    try {
      const ran = await withInstallLock(lockDir, async () => "ran", {
        staleMs: 1_000,
        pollMs: 10,
      });
      expect(ran).toBe("ran");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("releases the lock even when the critical section throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ffmpeg-lock-"));
    const lockDir = join(dir, "install-lock");
    try {
      await expect(
        withInstallLock(lockDir, async () => {
          throw new Error("install exploded");
        }),
      ).rejects.toThrow("install exploded");
      const reacquired = await withInstallLock(lockDir, async () => "ok", {
        pollMs: 10,
      });
      expect(reacquired).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
