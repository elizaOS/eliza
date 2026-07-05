/**
 * Proves two concurrent same-worktree ACP sessions (isolate:false) can commit
 * disjoint staged changes without either clobbering the other (#14183). Drives
 * the real per-session git wrapper (SESSION_GIT_WRAPPER via prepareSessionGitIndex)
 * against a real git repo, using a role-gated pre-commit hook to deterministically
 * park session A between its read-tree and its commit while session B commits.
 */

import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
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
});
