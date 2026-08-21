/**
 * Proves same-worktree ACP sessions get independent git index files (#13773),
 * including when a prewarmed child receives its session wrapper at claim time.
 * Without GIT_INDEX_FILE isolation, concurrent `git add` calls in two
 * isolate=false sessions mutate the repo's single .git/index and each session's
 * staged set clobbers the other.
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
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
import { AcpWarmSessionClaim } from "../../../../packages/examples/code/src/acp-session-claim.js";
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
    baselineDirty?: boolean,
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

function executableOnPath(name: string): string {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // error-policy:J3 probing continues until an executable is found.
    }
  }
  throw new Error(`${name} is not available on PATH`);
}

function runClaimedGitChild(
  repo: string,
  prepared:
    | { env: Record<string, string>; metadata: Record<string, string> }
    | undefined,
  token: string,
  commands: string[][],
): { resolvedGit: string } {
  if (!prepared) throw new Error("session git index was not prepared");
  const wrapperDir = prepared.metadata.gitWrapperDir;
  if (!wrapperDir) throw new Error("session git wrapper was not prepared");
  if (!bootExecutionPath)
    throw new Error("test host PATH baseline was not captured");
  const claimEnv = { ...prepared.env };
  delete claimEnv.PATH;
  const fixture = path.join(
    import.meta.dirname,
    "fixtures",
    "acp-warm-git-claim-child.ts",
  );
  const result = execFileSync(
    executableOnPath("bun"),
    ["--conditions=eliza-source", fixture],
    {
      cwd: path.resolve(import.meta.dirname, "../../../.."),
      env: {
        HOME: os.homedir(),
        PATH: "/bootstrap/must-not-win:/usr/bin:/bin",
        ELIZA_ACP_WARM_CLAIM_TOKEN: token,
      },
      input: JSON.stringify({
        claim: {
          token,
          env: claimEnv,
          executionPath: [wrapperDir, bootExecutionPath].join(path.delimiter),
        },
        cwd: repo,
        commands,
      }),
      encoding: "utf8",
    },
  );
  return JSON.parse(result) as { resolvedGit: string };
}

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
        executionPath: [wrapperDir, bootExecutionPath]
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

  it("refuses broad staging when the workspace was already dirty", async () => {
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const prepare = (
      service as unknown as GitIndexPreparer
    ).prepareSessionGitIndex.bind(service);
    const baselineSha = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(repo, "README.md"), "pre-existing user edit\n");
    const prepared = await prepare(
      repo,
      `${sessionPrefix}dirty-baseline`,
      baselineSha,
      true,
    );
    writeFileSync(path.join(repo, "task-file.txt"), "task output\n");

    expect(() => git(repo, ["add", "."], prepared?.env)).toThrow();
    expect(() => git(repo, ["add", "-A"], prepared?.env)).toThrow();
    git(repo, ["add", "task-file.txt"], prepared?.env);
    expect(git(repo, ["diff", "--cached", "--name-only"], prepared?.env)).toBe(
      "task-file.txt",
    );
    expect(() =>
      git(repo, ["commit", "-am", "unsafe"], prepared?.env),
    ).toThrow();
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

  it.skipIf(process.platform === "win32")(
    "commits both trees through real authenticated warm-child processes",
    async () => {
      const service = new AcpService(makeRuntime(), {
        store: new InMemorySessionStore(),
      });
      const prepare = (
        service as unknown as GitIndexPreparer
      ).prepareSessionGitIndex.bind(service);
      const baselineSha = git(repo, ["rev-parse", "HEAD"]);
      const preparedA = await prepare(
        repo,
        `${sessionPrefix}child-a`,
        baselineSha,
      );
      const preparedB = await prepare(
        repo,
        `${sessionPrefix}child-b`,
        baselineSha,
      );
      writeFileSync(path.join(repo, "child-a.txt"), "from child a\n");
      writeFileSync(path.join(repo, "child-b.txt"), "from child b\n");

      const receiptA = runClaimedGitChild(repo, preparedA, "child-token-a", [
        ["add", "child-a.txt"],
        ["commit", "-m", "claimed child a"],
      ]);
      const receiptB = runClaimedGitChild(repo, preparedB, "child-token-b", [
        ["add", "child-b.txt"],
        ["commit", "-m", "claimed child b"],
      ]);

      expect(receiptA.resolvedGit).toBe(
        path.join(preparedA?.metadata.gitWrapperDir ?? "", "git"),
      );
      expect(receiptB.resolvedGit).toBe(
        path.join(preparedB?.metadata.gitWrapperDir ?? "", "git"),
      );
      expect(git(repo, ["ls-tree", "--name-only", "-r", "HEAD"])).toBe(
        ["README.md", "child-a.txt", "child-b.txt"].join("\n"),
      );
    },
  );
});
