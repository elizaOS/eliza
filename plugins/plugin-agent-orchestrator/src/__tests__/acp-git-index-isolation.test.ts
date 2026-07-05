/**
 * Proves same-worktree ACP sessions get independent git index files (#13773).
 * Without GIT_INDEX_FILE isolation, concurrent `git add` calls in two
 * isolate=false sessions mutate the repo's single .git/index and each session's
 * staged set clobbers the other.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000013773",
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

describe("ACP per-session git index isolation (#13773)", () => {
  let tmpRoot: string;
  let repo: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "acp-git-index-"));
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

  it("stages independently for two sessions sharing one non-isolated workdir", async () => {
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
    expect(existsSync(sessionA?.env.GIT_INDEX_FILE ?? "")).toBe(true);
    expect(existsSync(sessionB?.env.GIT_INDEX_FILE ?? "")).toBe(true);

    writeFileSync(path.join(repo, "a.txt"), "from a\n");
    writeFileSync(path.join(repo, "b.txt"), "from b\n");

    git(repo, ["add", "a.txt"], sessionA?.env);
    git(repo, ["add", "b.txt"], sessionB?.env);

    expect(git(repo, ["diff", "--cached", "--name-only"], sessionA?.env)).toBe(
      "a.txt",
    );
    expect(git(repo, ["diff", "--cached", "--name-only"], sessionB?.env)).toBe(
      "b.txt",
    );
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");

    git(repo, ["commit", "-m", "session a"], sessionA?.env);
    git(repo, ["commit", "-m", "session b"], sessionB?.env);

    expect(git(repo, ["ls-tree", "--name-only", "-r", "HEAD"])).toBe(
      ["README.md", "a.txt", "b.txt"].join("\n"),
    );
  });
});
