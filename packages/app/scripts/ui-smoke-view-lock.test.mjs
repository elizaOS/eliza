/**
 * Exercises UI-smoke lock contention, stale-owner recovery, and ownership-safe
 * release against real temporary directories with deterministic liveness.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireUiSmokeViewLock,
  readUiSmokeLockOwner,
  uiSmokeLockStatus,
} from "./lib/ui-smoke-view-lock.mjs";

const tempDirs = [];

function tempLockDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ui-smoke-lock-"));
  tempDirs.push(root);
  return path.join(root, "view.lock");
}

function removeLock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("UI-smoke view lock", () => {
  it("never age-expires a live owner", () => {
    expect(
      uiSmokeLockStatus(
        { pid: 101, token: "live", acquiredAt: null },
        {
          ageMs: 60 * 60 * 1000,
          staleAfterMs: 30 * 60 * 1000,
          isProcessAlive: () => true,
        },
      ),
    ).toEqual({ reclaim: false, reason: "pid-alive" });
  });

  it("age-expires only unreadable owner metadata", () => {
    expect(
      uiSmokeLockStatus(null, {
        ageMs: 60 * 60 * 1000,
        staleAfterMs: 30 * 60 * 1000,
        isProcessAlive: () => true,
      }),
    ).toEqual({ reclaim: true, reason: "owner-unreadable-stale" });
  });

  it("waits instead of reclaiming an old lock whose pid is alive", () => {
    const lockDir = tempLockDir();
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, "owner"),
      `${JSON.stringify({ pid: 201, token: "holder" })}\n`,
    );
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockDir, old, old);

    expect(() =>
      acquireUiSmokeViewLock({
        lockDir,
        removeLock,
        sleep: () => {
          throw new Error("waited-for-live-owner");
        },
        isProcessAlive: () => true,
        pid: 202,
        token: "contender",
      }),
    ).toThrow("waited-for-live-owner");
    expect(readUiSmokeLockOwner(lockDir)).toMatchObject({
      pid: 201,
      token: "holder",
    });
  });

  it("reclaims a dead owner and releases its own lock", () => {
    const lockDir = tempLockDir();
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, "owner"),
      `${JSON.stringify({ pid: 301, token: "dead" })}\n`,
    );

    const release = acquireUiSmokeViewLock({
      lockDir,
      removeLock,
      sleep: () => {},
      isProcessAlive: (pid) => pid === 302,
      pid: 302,
      token: "replacement",
    });
    expect(readUiSmokeLockOwner(lockDir)).toMatchObject({
      pid: 302,
      token: "replacement",
    });

    release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("reclaims stale unreadable metadata after installing the guard", () => {
    const lockDir = tempLockDir();
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockDir, old, old);

    const release = acquireUiSmokeViewLock({
      lockDir,
      removeLock,
      sleep: () => {},
      isProcessAlive: () => true,
      staleAfterMs: 30 * 60 * 1000,
      pid: 350,
      token: "replacement",
    });
    expect(readUiSmokeLockOwner(lockDir)).toMatchObject({
      pid: 350,
      token: "replacement",
    });

    release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("does not remove a replacement lock when an old release runs late", () => {
    const lockDir = tempLockDir();
    const release = acquireUiSmokeViewLock({
      lockDir,
      removeLock,
      sleep: () => {},
      isProcessAlive: () => true,
      pid: 401,
      token: "first",
    });
    writeFileSync(
      path.join(lockDir, "owner"),
      `${JSON.stringify({ pid: 402, token: "replacement" })}\n`,
    );

    release();

    expect(existsSync(lockDir)).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(lockDir, "owner"), "utf8")),
    ).toMatchObject({
      pid: 402,
      token: "replacement",
    });
  });

  it("recovers when the elected reclaimer crashes after publishing", () => {
    const lockDir = tempLockDir();
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, "owner"),
      `${JSON.stringify({ pid: 451, token: "dead-owner" })}\n`,
    );
    const nowMs = Date.now();
    let nowCalls = 0;

    expect(() =>
      acquireUiSmokeViewLock({
        lockDir,
        removeLock: (target) => {
          if (target === lockDir) removeLock(target);
        },
        sleep: () => {},
        isProcessAlive: () => false,
        now: () => {
          nowCalls += 1;
          if (nowCalls === 3) {
            throw new Error("simulated-reclaimer-crash");
          }
          return nowMs;
        },
        pid: 452,
        token: "crashed-reclaimer",
      }),
    ).toThrow("simulated-reclaimer-crash");
    expect(
      readdirSync(path.dirname(lockDir)).some((name) =>
        name.startsWith(".ui-smoke-reclaim-"),
      ),
    ).toBe(true);

    const release = acquireUiSmokeViewLock({
      lockDir,
      removeLock,
      sleep: () => {},
      isProcessAlive: (pid) => pid === 453,
      pid: 453,
      token: "replacement",
    });
    expect(readUiSmokeLockOwner(lockDir)).toMatchObject({
      pid: 453,
      token: "replacement",
    });

    release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("preserves stale unreadable age when a reclaimer crashes after publishing", () => {
    const lockDir = tempLockDir();
    mkdirSync(lockDir);
    const nowMs = Date.now();
    const old = new Date(nowMs - 60 * 60 * 1000);
    utimesSync(lockDir, old, old);
    const staleMtime = statSync(lockDir).mtimeMs;
    let nowCalls = 0;

    expect(() =>
      acquireUiSmokeViewLock({
        lockDir,
        removeLock: (target) => {
          if (target === lockDir) removeLock(target);
        },
        sleep: () => {},
        isProcessAlive: () => false,
        staleAfterMs: 30 * 60 * 1000,
        now: () => {
          nowCalls += 1;
          if (nowCalls === 3) {
            throw new Error("simulated-unreadable-reclaimer-crash");
          }
          return nowMs;
        },
        pid: 471,
        token: "crashed-unreadable-reclaimer",
      }),
    ).toThrow("simulated-unreadable-reclaimer-crash");
    expect(statSync(lockDir).mtimeMs).toBe(staleMtime);

    const release = acquireUiSmokeViewLock({
      lockDir,
      removeLock,
      sleep: (milliseconds) => {
        if (milliseconds === 250) {
          throw new Error("stale-unreadable-lock-was-treated-as-fresh");
        }
      },
      isProcessAlive: (pid) => pid === 472,
      staleAfterMs: 30 * 60 * 1000,
      now: () => nowMs,
      pid: 472,
      token: "replacement",
    });
    expect(readUiSmokeLockOwner(lockDir)).toMatchObject({
      pid: 472,
      token: "replacement",
    });

    release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("holds the generation claim through validation and owner replacement", () => {
    const lockDir = tempLockDir();
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, "owner"),
      `${JSON.stringify({ pid: 601, token: "dead" })}\n`,
    );
    const nowMs = Date.now();
    let nowCalls = 0;
    let nestedRelease = null;
    let nestedBlocked = false;

    const release = acquireUiSmokeViewLock({
      lockDir,
      removeLock,
      sleep: () => {},
      isProcessAlive: (pid) => pid === 602 || pid === 603,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 3) {
          try {
            nestedRelease = acquireUiSmokeViewLock({
              lockDir,
              removeLock,
              sleep: (milliseconds) => {
                if (milliseconds === 250) {
                  throw new Error("waited-for-atomic-generation-claim");
                }
              },
              isProcessAlive: (pid) => pid === 602 || pid === 603,
              now: () => nowMs,
              pid: 602,
              token: "nested-earlier-contender",
              reclaimOrdinal: () => 1n,
            });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "waited-for-atomic-generation-claim"
            ) {
              nestedBlocked = true;
            } else {
              throw error;
            }
          }
        }
        return nowMs;
      },
      pid: 603,
      token: "outer-contender",
      reclaimOrdinal: () => 2n,
    });

    expect(nestedBlocked).toBe(true);
    expect(nestedRelease).toBeNull();
    expect(readUiSmokeLockOwner(lockDir)).toMatchObject({
      pid: 603,
      token: "outer-contender",
    });

    nestedRelease?.();
    release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("serializes contenders that observed the same stale owner", () => {
    const lockDir = tempLockDir();
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, "owner"),
      `${JSON.stringify({ pid: 501, token: "dead" })}\n`,
    );

    let replacementRelease;
    let replacementStarted = false;
    const contenderLiveness = (pid) => {
      if (pid === 501 && !replacementStarted) {
        replacementStarted = true;
        replacementRelease = acquireUiSmokeViewLock({
          lockDir,
          removeLock,
          sleep: () => {},
          isProcessAlive: (candidatePid) => candidatePid === 502,
          pid: 502,
          token: "replacement",
          reclaimOrdinal: () => 1n,
        });
      }
      return pid === 502;
    };

    expect(() =>
      acquireUiSmokeViewLock({
        lockDir,
        removeLock,
        sleep: (milliseconds) => {
          if (milliseconds === 250) {
            throw new Error("waited-for-replacement");
          }
        },
        isProcessAlive: contenderLiveness,
        pid: 503,
        token: "late-contender",
        reclaimOrdinal: () => 2n,
      }),
    ).toThrow("waited-for-replacement");

    expect(readUiSmokeLockOwner(lockDir)).toMatchObject({
      pid: 502,
      token: "replacement",
    });
    replacementRelease();
    expect(existsSync(lockDir)).toBe(false);
  });
});
