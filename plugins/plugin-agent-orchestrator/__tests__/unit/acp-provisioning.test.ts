/**
 * Crash-safety + multi-process-safety tests for the workspace-native
 * eliza-code ACP provisioning protocol (issue #16169).
 *
 * These exercise the deterministic properties required by the issue via the
 * injectable `build` / `isPidAlive` / `now` hooks, so no real Bun toolchain is
 * needed and crashes / PID reuse are reproducible:
 *
 *   - Multiple processes reclaim one dead lock; exactly one build runs.
 *   - A holder writing `partial` (crash before publish) never lets a waiter
 *     return until a validated, atomically published artifact exists.
 *   - A live owner past the wait budget is never overlapped.
 *   - Crash recovery + PID reuse simulation.
 *   - Workspace / Bun paths containing spaces round-trip through the command.
 *   - A failed build never leaves a fresh-looking executable artifact.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitCommandLine } from "../../src/services/acp-native-transport";
import {
  formatAcpCommand,
  provisionWorkspaceElizaCodeAcp,
} from "../../src/services/acp-provisioning";

const ACP_MARKER = "eliza-code-acp";
const roots: string[] = [];
const originalPath = process.env.PATH;

/** Create a checkout skeleton + a fake `bun` on PATH; returns key paths. */
function makeWorkspace(binName = "bun"): {
  root: string;
  packageDir: string;
  distDir: string;
  output: string;
  fakeBun: string;
} {
  const root = mkTemp();
  const packageDir = join(root, "packages", "examples", "code");
  const binDir = join(root, "bin");
  mkdirSync(join(packageDir, "src"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(packageDir, "src", "acp.ts"), "export {};\n");
  const fakeBun = join(binDir, binName);
  // Inert stub; production builds go through the injected `build` hook in these
  // tests, so the stub only needs to exist + be executable to satisfy the
  // PATH lookup.
  writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeBun, 0o755);
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  return {
    root,
    packageDir,
    distDir: join(packageDir, "dist"),
    output: join(packageDir, "dist", "acp.js"),
    fakeBun,
  };
}

function mkTemp(): string {
  // Sync unique-dir shim (tests stay synchronous alongside the sync provision
  // protocol they exercise).
  const dir = `${tmpdir()}/eliza-acp-prov-${process.pid}-${Math.random()
    .toString(36)
    .slice(2)}`;
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

/** A build hook that writes a valid marker-bearing artifact. */
function goodBuild(distDir: string, counter?: { n: number }) {
  return ({ tmpOutput }: { tmpOutput: string }) => {
    if (counter) counter.n += 1;
    mkdirSync(distDir, { recursive: true });
    writeFileSync(tmpOutput, `// ${ACP_MARKER}\nconsole.log("ok");\n`);
    return { ok: true, detail: "" };
  };
}

beforeEach(() => {
  process.env.PATH = originalPath;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provisionWorkspaceElizaCodeAcp — crash-safe protocol", () => {
  it("builds once and returns a structured command", () => {
    const ws = makeWorkspace();
    const counter = { n: 0 };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
    });
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
    expect(counter.n).toBe(1);
    expect(existsSync(ws.output)).toBe(true);
    expect(readFileSync(ws.output, "utf8")).toContain(ACP_MARKER);
  });

  it("is idempotent: a fresh artifact + marker skips rebuild", () => {
    const ws = makeWorkspace();
    const counter = { n: 0 };
    provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
    });
    expect(counter.n).toBe(1);
    // Second call must NOT rebuild.
    const again = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
    });
    expect(counter.n).toBe(1);
    expect(again).toEqual({ command: ws.fakeBun, args: [ws.output] });
  });

  it("a partial/unmarked artifact from a crashed build is NOT treated as fresh", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    // Simulate a crash: a truncated acp.js exists but no completion marker.
    writeFileSync(ws.output, "PARTIAL");
    const counter = { n: 0 };
    provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
    });
    // Because no matching marker existed, a rebuild must have run and replaced
    // the partial artifact with a validated one.
    expect(counter.n).toBe(1);
    expect(readFileSync(ws.output, "utf8")).toContain(ACP_MARKER);
  });

  it("a failed build never leaves a fresh-looking artifact and throws", () => {
    const ws = makeWorkspace();
    expect(() =>
      provisionWorkspaceElizaCodeAcp(ws.root, {
        build: () => ({ ok: false, detail: "boom" }),
      }),
    ).toThrow(/Failed to auto-install eliza-code-acp/);
    // No artifact and no completion marker → next provision rebuilds cleanly.
    expect(existsSync(ws.output)).toBe(false);
    const counter = { n: 0 };
    provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
    });
    expect(counter.n).toBe(1);
    expect(existsSync(ws.output)).toBe(true);
  });

  it("a build producing an invalid (marker-less) artifact is rejected", () => {
    const ws = makeWorkspace();
    expect(() =>
      provisionWorkspaceElizaCodeAcp(ws.root, {
        build: ({ tmpOutput }) => {
          mkdirSync(ws.distDir, { recursive: true });
          writeFileSync(tmpOutput, "no marker here");
          return { ok: true, detail: "" };
        },
      }),
    ).toThrow(/failed validation/);
    expect(existsSync(ws.output)).toBe(false);
  });

  it("multiple processes reclaim ONE dead lock; exactly one build runs", () => {
    const ws = makeWorkspace();
    // Pre-seed a stale lock owned by a dead PID (crash before release).
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    writeFileSync(
      lock,
      JSON.stringify({ pid: 999999, fence: "deadfence", startedAtMs: 0 }),
    );
    const deadPid = 999999;
    const isPidAlive = (pid: number) => pid !== deadPid; // dead owner only
    // Deadline immediately elapsed so reclaim is attempted at once.
    const now = () => 10_000_000;
    const counter = { n: 0 };

    // Simulate N racers sequentially (single-threaded test): the first reclaims
    // + builds; the rest see the fresh artifact and never build.
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(
        provisionWorkspaceElizaCodeAcp(ws.root, {
          build: goodBuild(ws.distDir, counter),
          isPidAlive,
          now,
        }),
      );
    }
    expect(counter.n).toBe(1);
    for (const r of results) {
      expect(r).toEqual({ command: ws.fakeBun, args: [ws.output] });
    }
  });

  it("never overlaps a VERIFIED-LIVE owner past the wait budget", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    const liveOwnerPid = 424242;
    writeFileSync(
      lock,
      JSON.stringify({ pid: liveOwnerPid, fence: "livefence", startedAtMs: 0 }),
    );
    const isPidAlive = (pid: number) => pid === liveOwnerPid; // owner is alive

    // Advance the clock past the deadline on the FIRST poll, then have the live
    // owner "finish" by publishing a fresh artifact so the waiter can return
    // without ever stealing the lock.
    let tick = 0;
    const now = () => {
      tick += 1;
      // First few calls are before the deadline; then jump past it.
      return tick < 3 ? 0 : 10_000_000_000;
    };

    let waiterBuilt = false;
    // After the deadline elapses and the waiter confirms the owner is alive, it
    // polls again. On that poll, simulate the live owner publishing.
    const publishFromOwner = () => {
      writeFileSync(ws.output, `// ${ACP_MARKER}\nconsole.log("owner");\n`);
      const st = statSync(ws.output);
      writeFileSync(
        join(ws.distDir, ".acp.done"),
        JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs }),
      );
    };
    // Publish before the waiter loops so the next freshness check succeeds.
    publishFromOwner();

    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: () => {
        waiterBuilt = true;
        return goodBuild(ws.distDir)({ tmpOutput: "" } as never);
      },
      isPidAlive,
      now,
    });
    // The waiter must have returned the owner's published artifact WITHOUT
    // building (it never overlapped/stole from the live owner).
    expect(waiterBuilt).toBe(false);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
  });

  it("crash recovery: a dead owner's lock is reclaimed on the next start", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    // Owner crashed mid-build: stale lock, partial artifact, no marker.
    writeFileSync(
      lock,
      JSON.stringify({ pid: 777001, fence: "crashfence", startedAtMs: 0 }),
    );
    writeFileSync(ws.output, "PARTIAL-CRASH");
    const isPidAlive = () => false; // the crashed owner is gone
    const now = () => 10_000_000; // deadline already elapsed

    const counter = { n: 0 };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
      isPidAlive,
      now,
    });
    expect(counter.n).toBe(1);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
    expect(readFileSync(ws.output, "utf8")).toContain(ACP_MARKER);
    // The lock we created + released during recovery is gone.
    expect(existsSync(lock)).toBe(false);
  });

  it("PID reuse: a reused-but-alive PID only delays reclaim, never mis-reclaims", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    const reusedPid = 555001;
    // The original owner crashed, but the PID was reused by an unrelated live
    // process, so liveness reports alive.
    writeFileSync(
      lock,
      JSON.stringify({ pid: reusedPid, fence: "stalefence", startedAtMs: 0 }),
    );

    // Liveness: the reused PID is "alive" for the first two checks, then the
    // unrelated process exits and the stale lock becomes reclaimable.
    let checks = 0;
    const isPidAlive = (pid: number) => {
      if (pid !== reusedPid) return false;
      checks += 1;
      return checks <= 2;
    };
    const now = () => 10_000_000; // past deadline throughout

    const counter = { n: 0 };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
      isPidAlive,
      now,
    });
    // A reused live PID never authorized deleting the lock; only once it was
    // observed dead did reclaim + build proceed. Exactly one build.
    expect(counter.n).toBe(1);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
  });

  it("reclaim installs a lock atomically and never leaves paths.lock absent (no gap for a third builder)", () => {
    // Reclaim of a stale (dead-owner) lock must REPLACE it atomically — the lock
    // path is never momentarily missing — so a concurrent acquirer can never win
    // open('wx') during a reclaim gap. We assert the lock file exists at every
    // observable point of the reclaim by checking it from inside the build hook
    // (which only runs once the reclaimer holds the lock).
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    writeFileSync(
      lock,
      JSON.stringify({ pid: 111, fence: "stale", startedAtMs: 0 }),
    );
    let lockPresentDuringBuild = false;
    let heldFence: string | undefined;
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: ({ tmpOutput }) => {
        // While building, the reclaimer must hold a lock under its OWN fence.
        lockPresentDuringBuild = existsSync(lock);
        heldFence = JSON.parse(readFileSync(lock, "utf8")).fence;
        mkdirSync(ws.distDir, { recursive: true });
        writeFileSync(tmpOutput, `// ${ACP_MARKER}\nok\n`);
        return { ok: true, detail: "" };
      },
      isPidAlive: () => false, // stale owner dead → reclaimable
      now: () => 10_000_000,
    });
    expect(lockPresentDuringBuild).toBe(true);
    expect(heldFence).toBeDefined();
    expect(heldFence).not.toBe("stale"); // installed under the reclaimer's fence
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
    // Lock released after a successful build.
    expect(existsSync(lock)).toBe(false);
  });

  it("single-winner reclaim: a held reclaim-intent gate blocks a second reclaimer", () => {
    // While one reclaimer holds the single-winner intent gate (its build is in
    // flight), a second reclaimer of the same stale lock must NOT reclaim — it
    // sees the intent file (EEXIST) and backs off. This is what keeps two
    // reclaimers from both running the shared `bun run build` concurrently.
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    const intent = join(ws.distDir, ".acp.build.reclaiming");
    writeFileSync(
      lock,
      JSON.stringify({ pid: 111, fence: "stale", startedAtMs: 0 }),
    );
    // Simulate winner #1 currently mid-reclaim: its intent gate is held by a
    // LIVE holder PID (so it is not reclaimable) and fresh (not aged out).
    const intentHolderPid = 424242;
    writeFileSync(
      intent,
      JSON.stringify({ pid: intentHolderPid, startedAtMs: Date.now() }),
    );

    let builds = 0;
    let threw = false;
    // Clock advances past the deadline so the blocked reclaimer eventually
    // surfaces a timeout instead of spinning the real clock. The stale LOCK
    // owner (111) is dead, but the intent gate holder is alive.
    let clock = 0;
    const now = () => {
      const t = clock;
      clock += 100_000;
      return t;
    };
    try {
      provisionWorkspaceElizaCodeAcp(ws.root, {
        build: () => {
          builds += 1;
          return { ok: true, detail: "" };
        },
        // Stale lock owner dead; intent-gate holder alive (gate stays held).
        isPidAlive: (pid) => pid === intentHolderPid,
        now,
      });
    } catch {
      threw = true;
    }
    // The second reclaimer never built (gate held) and the intent gate is
    // untouched (only its owner releases it).
    expect(builds).toBe(0);
    expect(threw).toBe(true);
    expect(existsSync(intent)).toBe(true);
  });

  it("single-winner reclaim: a DEAD intent-holder gate is cleared IMMEDIATELY (within the deadline)", () => {
    // If the intent-holding reclaimer crashed, its gate must be recoverable via
    // a liveness check on the recorded holder PID — immediately, not after the
    // multi-minute wall-clock ceiling — so crash recovery completes inside the
    // outer provisioning deadline.
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    const intent = join(ws.distDir, ".acp.build.reclaiming");
    writeFileSync(
      lock,
      JSON.stringify({ pid: 111, fence: "stale", startedAtMs: 0 }),
    );
    const deadHolderPid = 909090;
    writeFileSync(
      intent,
      JSON.stringify({ pid: deadHolderPid, startedAtMs: Date.now() }),
    );
    const counter = { n: 0 };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
      // Both the stale lock owner and the crashed intent holder are dead. A
      // constant real-time clock keeps us WELL within the deadline, proving
      // recovery does not depend on aging past the ceiling.
      isPidAlive: () => false,
      now: () => Date.now(),
    });
    expect(counter.n).toBe(1);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(intent)).toBe(false);
  });

  it("single-winner reclaim: an ABANDONED (aged-out) intent gate is cleared so reclaim can progress", () => {
    // If the intent-holding reclaimer crashed, its stale intent file must be
    // aged out so a later reclaimer is not deadlocked. Here the intent is old
    // (mtime far in the past relative to the clock), so it is cleared and
    // reclaim eventually proceeds.
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    const intent = join(ws.distDir, ".acp.build.reclaiming");
    writeFileSync(
      lock,
      JSON.stringify({ pid: 111, fence: "stale", startedAtMs: 0 }),
    );
    writeFileSync(intent, "crashed-holder");
    // Clock is far past the intent's real mtime so it ages out on the first
    // reclaim attempt; a subsequent attempt then wins the freed gate.
    const now = () => Date.now() + 24 * 60 * 60 * 1000;
    const counter = { n: 0 };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
      isPidAlive: () => false,
      now,
    });
    expect(counter.n).toBe(1);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
    // Both the lock and the reclaim gate are released after a successful build.
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(intent)).toBe(false);
  });

  it("overlapping builds never corrupt or partially publish the artifact (atomic-publish invariant)", () => {
    // The lock is advisory; correctness lives in the atomic publish. Simulate a
    // second builder finishing DURING our build by publishing a different valid
    // artifact mid-flight, then assert the final published acp.js is always a
    // complete, marker-consistent artifact (never a partial/torn file) and its
    // completion marker matches it exactly.
    const ws = makeWorkspace();
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: ({ tmpOutput }) => {
        mkdirSync(ws.distDir, { recursive: true });
        // A concurrent builder atomically publishes its own complete artifact
        // + marker before we publish ours.
        writeFileSync(ws.output, `// ${ACP_MARKER}\nfrom-other-builder\n`);
        const st = statSync(ws.output);
        writeFileSync(
          join(ws.distDir, ".acp.done"),
          JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs }),
        );
        // Our build then publishes its own complete artifact.
        writeFileSync(tmpOutput, `// ${ACP_MARKER}\nfrom-us\n`);
        return { ok: true, detail: "" };
      },
    });
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
    // Final artifact is complete + valid, and the marker describes it exactly.
    const content = readFileSync(ws.output, "utf8");
    expect(content).toContain(ACP_MARKER);
    const st = statSync(ws.output);
    const marker = JSON.parse(
      readFileSync(join(ws.distDir, ".acp.done"), "utf8"),
    ) as { size: number; mtimeMs: number };
    expect(marker.size).toBe(st.size);
    expect(marker.mtimeMs).toBe(st.mtimeMs);
  });

  it("reclaim leaves no scratch claim temp behind after a successful reclaim", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    writeFileSync(
      lock,
      JSON.stringify({ pid: 111, fence: "old", startedAtMs: 0 }),
    );
    const isPidAlive = () => false;
    const now = () => 10_000_000;
    provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir),
      isPidAlive,
      now,
    });
    // No lingering `.claim.` / `.reclaim.` scratch temps after reclaim.
    const leftovers = readdirSync(ws.distDir).filter(
      (f: string) => f.includes(".claim.") || f.includes(".reclaim."),
    );
    expect(leftovers).toEqual([]);
  });

  it("reclaims when a crashed owner's PID is reused by a long-lived process (lock past lifetime ceiling)", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    const reusedPid = 314159;
    // The original builder crashed long ago; startedAtMs is far in the past.
    // The PID was reused by an unrelated process that is ALWAYS alive.
    writeFileSync(
      lock,
      JSON.stringify({ pid: reusedPid, fence: "ancient", startedAtMs: 0 }),
    );
    // Clock is well past the absolute lock lifetime ceiling relative to the
    // lock file's real mtime (the age anchor is max(startedAtMs, mtime)).
    const now = () => Date.now() + 24 * 60 * 60 * 1000;
    const counter = { n: 0 };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
      isPidAlive: (pid) => pid === reusedPid, // reused PID is perpetually alive
      now,
    });
    // Past the ceiling, liveness is overridden and the stale lock reclaimed;
    // exactly one build runs and the artifact is published.
    expect(counter.n).toBe(1);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
    expect(existsSync(lock)).toBe(false);
  });

  it("does NOT override liveness before the lifetime ceiling (slow live build)", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    const liveOwnerPid = 271828;
    const nowMs = Date.now();
    writeFileSync(
      lock,
      JSON.stringify({
        pid: liveOwnerPid,
        fence: "slow",
        startedAtMs: nowMs,
      }),
    );
    // The slow-but-live owner "finishes" by publishing a fresh artifact after a
    // couple of reclaim probes; the waiter must return that WITHOUT building or
    // reclaiming, because the lock has not aged past the ceiling. Drive the
    // publish off isPidAlive (called once per loop iteration during the reclaim
    // attempt) so the trigger is deterministic regardless of now() call count.
    let builds = 0;
    let probes = 0;
    const isPidAlive = (pid: number) => {
      if (pid !== liveOwnerPid) return false;
      probes += 1;
      if (probes === 2) {
        writeFileSync(ws.output, `// ${ACP_MARKER}\nslow-owner\n`);
        const st = statSync(ws.output);
        writeFileSync(
          join(ws.distDir, ".acp.done"),
          JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs }),
        );
      }
      return true;
    };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: () => {
        builds += 1;
        return { ok: true, detail: "" };
      },
      isPidAlive,
      now: () => nowMs, // stays well within the lifetime ceiling
    });
    expect(builds).toBe(0);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
  });

  it("reclaims a MALFORMED lock left by a crash mid-claim (no owner record)", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    // An owner crashed between open('wx') and writing its record: the lock file
    // exists but is empty/unparseable. Age it past the grace window.
    writeFileSync(lock, "");
    // Clock is far ahead of the lock's real mtime so the malformed-lock grace
    // has elapsed.
    const now = () => Date.now() + 60_000;
    const counter = { n: 0 };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: goodBuild(ws.distDir, counter),
      isPidAlive: () => false,
      now,
    });
    expect(counter.n).toBe(1);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
    expect(existsSync(lock)).toBe(false);
  });

  it("does NOT reclaim a fresh malformed lock within the grace window (mid-claim owner)", () => {
    const ws = makeWorkspace();
    mkdirSync(ws.distDir, { recursive: true });
    const lock = join(ws.distDir, ".acp.build.lock");
    // A live owner just created the empty lock and is about to write its
    // record; its mtime is "now", inside the grace window.
    writeFileSync(lock, "");
    let builds = 0;
    // Real clock (grace not elapsed) + an immediate attempt budget so we don't
    // spin the real 3-minute deadline: the mid-claim owner "finishes" by
    // publishing a fresh artifact, which the waiter then returns.
    let polls = 0;
    const now = () => {
      polls += 1;
      // First iterations: real time (grace NOT elapsed → no reclaim). After a
      // couple polls, the owner publishes so freshness short-circuits.
      if (polls === 2) {
        writeFileSync(ws.output, `// ${ACP_MARKER}\npublished\n`);
        const st = statSync(ws.output);
        writeFileSync(
          join(ws.distDir, ".acp.done"),
          JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs }),
        );
      }
      return Date.now();
    };
    const result = provisionWorkspaceElizaCodeAcp(ws.root, {
      build: () => {
        builds += 1;
        return { ok: true, detail: "" };
      },
      isPidAlive: () => true,
      now,
    });
    // The waiter must NOT have reclaimed/overlapped the mid-claim owner: it
    // waited for the owner's published artifact instead of building.
    expect(builds).toBe(0);
    expect(result).toEqual({ command: ws.fakeBun, args: [ws.output] });
  });

  it("returns undefined when no workspace package or bun is available", () => {
    // Point PATH somewhere without bun and use a startDir with no package.
    const empty = mkTemp();
    process.env.PATH = "/nonexistent-dir-for-test";
    const result = provisionWorkspaceElizaCodeAcp(empty, {
      build: goodBuild(join(empty, "dist")),
    });
    expect(result).toBeUndefined();
  });
});

describe("formatAcpCommand — space-safe path propagation", () => {
  it("double-quotes bun + args so splitCommandLine round-trips spaces", () => {
    const result = {
      command: "/opt/my bun/bin/bun",
      args: ["/work space/dist/acp.js"],
    };
    const line = formatAcpCommand(result);
    expect(line).toBe(`"/opt/my bun/bin/bun" "/work space/dist/acp.js"`);
    const parsed = splitCommandLine(line);
    expect(parsed.command).toBe("/opt/my bun/bin/bun");
    expect(parsed.args).toEqual(["/work space/dist/acp.js"]);
  });

  it("leaves quote-free paths bare and round-trips paths containing quote chars", () => {
    // A double-quote in the path is single-quoted (and vice versa) so
    // splitCommandLine's non-escaping grammar still reconstructs it.
    const dq = formatAcpCommand({
      command: '/tmp/a"b/bin/bun',
      args: ['/w"s/dist/acp.js'],
    });
    expect(splitCommandLine(dq)).toEqual({
      command: '/tmp/a"b/bin/bun',
      args: ['/w"s/dist/acp.js'],
    });
    const sq = formatAcpCommand({
      command: "/tmp/it's/bin/bun",
      args: ["/plain/dist/acp.js"],
    });
    expect(splitCommandLine(sq)).toEqual({
      command: "/tmp/it's/bin/bun",
      args: ["/plain/dist/acp.js"],
    });
    // Quote-free tokens stay bare (no needless quoting).
    expect(
      formatAcpCommand({ command: "/usr/bin/bun", args: ["/w/dist/acp.js"] }),
    ).toBe("/usr/bin/bun /w/dist/acp.js");
  });

  it("provisioned command survives a workspace path containing a space", () => {
    // Build the workspace under a directory whose name contains a space.
    const spaced = mkTemp();
    const spacedRoot = join(spaced, "with space");
    const packageDir = join(spacedRoot, "packages", "examples", "code");
    const binDir = join(spacedRoot, "bin");
    mkdirSync(join(packageDir, "src"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(packageDir, "src", "acp.ts"), "export {};\n");
    const fakeBun = join(binDir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBun, 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const distDir = join(packageDir, "dist");
    const result = provisionWorkspaceElizaCodeAcp(spacedRoot, {
      build: goodBuild(distDir),
    });
    if (!result) throw new Error("expected a provisioned command");
    const line = formatAcpCommand(result);
    const parsed = splitCommandLine(line);
    expect(parsed.command).toBe(fakeBun);
    expect(parsed.args).toEqual([join(distDir, "acp.js")]);
  });
});
