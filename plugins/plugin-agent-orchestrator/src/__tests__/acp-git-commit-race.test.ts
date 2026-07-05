/**
 * Proves two concurrent same-worktree ACP sessions (isolate:false) can commit
 * disjoint staged changes without either clobbering the other (#14183). Drives
 * the real per-session git wrapper (SESSION_GIT_WRAPPER via prepareSessionGitIndex)
 * against a real git repo, using a role-gated pre-commit hook to deterministically
 * park session A between its read-tree and its commit while session B commits.
 */

import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000014183",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
  } as never;
}

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", repo, ...args], {
    env: { ...process.env, ...(env ?? {}) },
    encoding: "utf8",
  }).trim();
}

function gitAsync(
  repo: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile("git", ["-C", repo, ...args], { env }, (err, _stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code ?? 1)
          : err
            ? 1
            : 0;
      resolveRun({ code, stderr: stderr ?? "" });
    });
  });
}

async function waitForFile(target: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(target)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${target}`);
}

// A real, long-lived process whose PID stands in for the number a crashed
// holder's PID was recycled to — process.kill(pid, 0) reports it alive.
function spawnLiveChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
}

type GitIndexPreparer = {
  prepareSessionGitIndex(
    workdir: string,
    sessionId: string,
    baselineSha?: string,
  ): Promise<
    | {
        env: Record<string, string>;
        metadata: Record<string, string>;
      }
    | undefined
  >;
};

describe("ACP per-session commit race on a shared worktree (#14183)", () => {
  let tmpRoot: string;
  let repo: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "acp-commit-race-"));
    repo = path.join(tmpRoot, "repo");
    oldHome = process.env.HOME;
    process.env.HOME = path.join(tmpRoot, "home");

    git(tmpRoot, ["init", repo]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "ACP Test"]);
    writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("lands both commits when two sessions commit concurrently in one workdir", async () => {
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const prepare = (
      service as unknown as GitIndexPreparer
    ).prepareSessionGitIndex.bind(service);

    const baselineSha = git(repo, ["rev-parse", "HEAD"]);
    const sessionA = await prepare(repo, "sess-a", baselineSha);
    const sessionB = await prepare(repo, "sess-b", baselineSha);
    expect(sessionA?.env.GIT_INDEX_FILE).toBeTruthy();
    expect(sessionB?.env.GIT_INDEX_FILE).toBeTruthy();
    expect(sessionA?.env.GIT_INDEX_FILE).not.toBe(sessionB?.env.GIT_INDEX_FILE);

    writeFileSync(path.join(repo, "a.txt"), "from a\n");
    writeFileSync(path.join(repo, "b.txt"), "from b\n");
    git(repo, ["add", "a.txt"], sessionA?.env);
    git(repo, ["add", "b.txt"], sessionB?.env);

    // Role A parks in its pre-commit hook AFTER the wrapper's read-tree HEAD but
    // BEFORE git records the commit's parent — exactly the window #14183 races.
    // Role B commits freely during that park, advancing HEAD. Without the
    // worktree lock, A then commits a tree rebuilt from the stale HEAD and
    // silently reverts b.txt; with the lock, B blocks until A releases and both
    // land on a linear history.
    const signalFile = path.join(tmpRoot, "a-entered-precommit");
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(
      hookPath,
      `#!/bin/sh
if [ "$ACP_TEST_ROLE" = "A" ]; then
  : > "${signalFile}"
  sleep 1.5
fi
exit 0
`,
    );
    chmodSync(hookPath, 0o755);

    const envA = { ...process.env, ...sessionA?.env, ACP_TEST_ROLE: "A" };
    const envB = { ...process.env, ...sessionB?.env, ACP_TEST_ROLE: "B" };

    const commitA = gitAsync(repo, ["commit", "-m", "session a"], envA);
    await waitForFile(signalFile, 10_000);
    const commitB = gitAsync(repo, ["commit", "-m", "session b"], envB);

    const [resultA, resultB] = await Promise.all([commitA, commitB]);
    expect(resultA.code, `session a failed: ${resultA.stderr}`).toBe(0);
    expect(resultB.code, `session b failed: ${resultB.stderr}`).toBe(0);

    const tree = git(repo, ["ls-tree", "--name-only", "-r", "HEAD"]);
    expect(tree.split("\n").filter(Boolean).sort()).toEqual([
      "README.md",
      "a.txt",
      "b.txt",
    ]);

    expect(Number(git(repo, ["rev-list", "--count", "HEAD"]))).toBe(3);
    const parents = git(repo, ["log", "--pretty=%P", "HEAD"]).split("\n");
    for (const line of parents) {
      const parentCount = line.trim().split(/\s+/).filter(Boolean).length;
      expect(parentCount).toBeLessThanOrEqual(1);
    }
  }, 30_000);

  it("reclaims a stale commit lock without leaving reclaim artifacts", async () => {
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const prepare = (
      service as unknown as GitIndexPreparer
    ).prepareSessionGitIndex.bind(service);

    const baselineSha = git(repo, ["rev-parse", "HEAD"]);
    const session = await prepare(repo, "sess-stale", baselineSha);
    expect(session?.env.GIT_INDEX_FILE).toBeTruthy();

    const lockPath = path.join(repo, ".git", "eliza-acp-commit.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99_999_999,
        token: "dead-owner",
        createdAt: Date.now() - 600_000,
      }),
    );

    writeFileSync(path.join(repo, "stale.txt"), "after stale lock\n");
    git(repo, ["add", "stale.txt"], session?.env);
    git(repo, ["commit", "-m", "reclaim stale lock"], session?.env);

    expect(git(repo, ["ls-tree", "--name-only", "-r", "HEAD"])).toBe(
      ["README.md", "stale.txt"].join("\n"),
    );
    expect(existsSync(lockPath)).toBe(false);
    expect(
      readdirSync(path.join(repo, ".git")).filter((name) =>
        name.startsWith("eliza-acp-commit.lock."),
      ),
    ).toEqual([]);
  });

  // A crashed holder's PID can be recycled by the OS to an unrelated live
  // process. processAlive() then reports it alive, so before #14202 lockIsStale
  // returned "not stale" for it and never consulted the mtime backstop — the dead
  // lock wedged the worktree until the 120s acquire deadline, then threw. With the
  // backstop reachable for a live PID, the aged lock is reclaimed at once. The
  // tight 20s timeout is itself the guard: a regression to never-reclaim wedges
  // for LOCK_WAIT_MS (120s) and fails here.
  it("reclaims a stale lock whose crashed holder's PID was recycled to a live process (#14202)", async () => {
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const prepare = (
      service as unknown as GitIndexPreparer
    ).prepareSessionGitIndex.bind(service);

    const baselineSha = git(repo, ["rev-parse", "HEAD"]);
    const session = await prepare(repo, "sess-recycled", baselineSha);
    expect(session?.env.GIT_INDEX_FILE).toBeTruthy();

    writeFileSync(path.join(repo, "recycled.txt"), "after recycled-pid lock\n");
    git(repo, ["add", "recycled.txt"], session?.env);

    const live = spawnLiveChild();
    try {
      expect(() => process.kill(live.pid as number, 0)).not.toThrow();
      const lockPath = path.join(repo, ".git", "eliza-acp-commit.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: live.pid,
          token: "recycled-owner",
          createdAt: Date.now() - 600_000,
        }),
      );
      // Age the mtime well past LOCK_STALE_MS (30s) so the backstop fires.
      const old = new Date(Date.now() - 600_000);
      utimesSync(lockPath, old, old);

      const result = await gitAsync(
        repo,
        ["commit", "-m", "reclaim recycled-pid lock"],
        { ...process.env, ...session?.env },
      );
      expect(result.code, `commit failed: ${result.stderr}`).toBe(0);
      expect(
        git(repo, ["ls-tree", "--name-only", "-r", "HEAD"]).split("\n"),
      ).toContain("recycled.txt");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      try {
        live.kill("SIGKILL");
      } catch {
        // error-policy:J6 test teardown; child may already be gone.
      }
    }
  }, 20_000);

  // The mtime backstop must not over-reach: a fresh lock held by a genuinely live
  // process is NOT stale, so the wrapper must wait for it rather than steal it.
  it("does not falsely reclaim a fresh, live-held commit lock (#14202)", async () => {
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const prepare = (
      service as unknown as GitIndexPreparer
    ).prepareSessionGitIndex.bind(service);

    const baselineSha = git(repo, ["rev-parse", "HEAD"]);
    const session = await prepare(repo, "sess-wait", baselineSha);
    expect(session?.env.GIT_INDEX_FILE).toBeTruthy();

    writeFileSync(
      path.join(repo, "waited.txt"),
      "after waiting for a live holder\n",
    );
    git(repo, ["add", "waited.txt"], session?.env);

    // Held by this (alive) process with a fresh mtime → not stale.
    const lockPath = path.join(repo, ".git", "eliza-acp-commit.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: "live-holder",
        createdAt: Date.now(),
      }),
    );

    let done = false;
    const commit = gitAsync(repo, ["commit", "-m", "waits for live holder"], {
      ...process.env,
      ...session?.env,
    }).then((r) => {
      done = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 800));
    // Still blocked: a fresh, live-held lock was not stolen.
    expect(done, "wrapper reclaimed a fresh, live-held lock").toBe(false);
    expect(readFileSync(lockPath, "utf8")).toContain("live-holder");

    // Release the held lock; the waiting wrapper now acquires and commits.
    rmSync(lockPath, { force: true });
    const result = await commit;
    expect(result.code, `commit failed: ${result.stderr}`).toBe(0);
    expect(
      git(repo, ["ls-tree", "--name-only", "-r", "HEAD"]).split("\n"),
    ).toContain("waited.txt");
  }, 20_000);
});
