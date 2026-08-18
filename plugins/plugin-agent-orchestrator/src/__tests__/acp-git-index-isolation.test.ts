/**
 * Proves same-worktree ACP sessions get independent git index files (#13773),
 * including when a prewarmed child receives its session wrapper at claim time.
 * Without GIT_INDEX_FILE isolation, concurrent `git add` calls in two
 * isolate=false sessions mutate the repo's single .git/index and each session's
 * staged set clobbers the other.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpWarmSessionClaim } from "../../../../packages/examples/code/src/acp-session-claim.js";
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
  const wrapperDir = env?.ACP_GIT_INDEX_FILE
    ? env.PATH?.split(path.delimiter)[0]
    : undefined;
  const wrapper = wrapperDir ? path.join(wrapperDir, "git") : undefined;
  const interpreter = wrapper
    ? readFileSync(wrapper, "utf8").split("\n", 1)[0]?.slice(2)
    : undefined;
  const executable = interpreter || "git";
  const commandArgs = wrapper
    ? [wrapper, "-C", repo, ...args]
    : ["-C", repo, ...args];
  return execFileSync(executable, commandArgs, {
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

function claimWarmSessionEnv(
  prepared:
    | { env: Record<string, string>; metadata: Record<string, string> }
    | undefined,
  token: string,
): NodeJS.ProcessEnv {
  if (!prepared) throw new Error("session git index was not prepared");
  const wrapperDir = prepared.metadata.gitWrapperDir;
  if (!wrapperDir) throw new Error("session git wrapper was not prepared");
  const target: NodeJS.ProcessEnv = {};
  const claim = new AcpWarmSessionClaim(token);
  claim.apply(
    {
      elizaSessionClaim: {
        token,
        env: prepared.env,
        executionPath: [wrapperDir, process.env.PATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
    },
    target,
  );
  return target;
}

describe("ACP per-session git index isolation (#13773)", () => {
  let tmpRoot: string;
  let repo: string;
  let sessionPrefix: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "acp-git-index-"));
    repo = path.join(tmpRoot, "repo");
    sessionPrefix = `${path.basename(tmpRoot)}-`;

    git(tmpRoot, ["init", repo]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "ACP Test"]);
    writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
  });

  afterEach(() => {
    const indexRoot = path.join(os.homedir(), ".acpx", "git-indexes");
    if (existsSync(indexRoot)) {
      for (const name of readdirSync(indexRoot)) {
        if (name.startsWith(sessionPrefix)) {
          rmSync(path.join(indexRoot, name), { recursive: true, force: true });
        }
      }
    }
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
    const sessionA = await prepare(repo, `${sessionPrefix}sess-a`, baselineSha);
    const sessionB = await prepare(repo, `${sessionPrefix}sess-b`, baselineSha);

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

  it("lands both commits through independently claimed warm-child wrapper paths", async () => {
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const prepare = (
      service as unknown as GitIndexPreparer
    ).prepareSessionGitIndex.bind(service);
    const baselineSha = git(repo, ["rev-parse", "HEAD"]);
    const preparedA = await prepare(
      repo,
      `${sessionPrefix}warm-a`,
      baselineSha,
    );
    const preparedB = await prepare(
      repo,
      `${sessionPrefix}warm-b`,
      baselineSha,
    );
    const envA = claimWarmSessionEnv(preparedA, "warm-token-a");
    const envB = claimWarmSessionEnv(preparedB, "warm-token-b");

    expect(envA.PATH?.split(path.delimiter)[0]).toBe(
      preparedA?.metadata.gitWrapperDir,
    );
    expect(envB.PATH?.split(path.delimiter)[0]).toBe(
      preparedB?.metadata.gitWrapperDir,
    );
    expect(envA.PATH).not.toContain("bootstrap/must-not-win");
    expect(envB.PATH).not.toContain("bootstrap/must-not-win");

    writeFileSync(path.join(repo, "warm-a.txt"), "from warm a\n");
    writeFileSync(path.join(repo, "warm-b.txt"), "from warm b\n");
    git(repo, ["add", "warm-a.txt"], envA);
    git(repo, ["add", "warm-b.txt"], envB);
    git(repo, ["commit", "-m", "warm session a"], envA);
    git(repo, ["commit", "-m", "warm session b"], envB);

    expect(git(repo, ["ls-tree", "--name-only", "-r", "HEAD"])).toBe(
      ["README.md", "warm-a.txt", "warm-b.txt"].join("\n"),
    );
  });
});
