/**
 * Proves same-worktree ACP sessions get independent git index files using
 * real Git repositories, commits, and the orchestrator-owned wrapper paths.
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
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";

const originalTestPath = process.env.PATH;
process.env.PATH = originalTestPath
  ?.split(path.delimiter)
  .filter((entry) => path.isAbsolute(entry))
  .join(path.delimiter);
const bootExecutionPath = captureHostExecutionBaseline().path;
process.env.PATH = originalTestPath;

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

type TrustedExecutionPathResolver = {
  trustedSessionExecutionPath(session: {
    id: string;
    metadata?: Record<string, string>;
  }): string;
};

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

  it("builds the warm claim PATH from boot authority and the owned wrapper only", async () => {
    expect(bootExecutionPath).toBeTruthy();
    const sessionId = `${sessionPrefix}trusted-path`;
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const prepare = (
      service as unknown as GitIndexPreparer
    ).prepareSessionGitIndex.bind(service);
    const resolveTrustedPath = (
      service as unknown as TrustedExecutionPathResolver
    ).trustedSessionExecutionPath.bind(service);
    const prepared = await prepare(repo, sessionId);
    if (!prepared) throw new Error("session git index was not prepared");

    const previousPath = process.env.PATH;
    process.env.PATH = "/tmp/untrusted-runtime-path";
    try {
      expect(
        resolveTrustedPath({ id: sessionId, metadata: prepared.metadata }),
      ).toBe(
        [prepared.metadata.gitWrapperDir, bootExecutionPath].join(
          path.delimiter,
        ),
      );
    } finally {
      process.env.PATH = previousPath;
    }

    expect(() =>
      resolveTrustedPath({
        id: sessionId,
        metadata: { gitWrapperDir: path.join(tmpRoot, "forged", "bin") },
      }),
    ).toThrow("Session git wrapper is outside its owned root");
  });
});
