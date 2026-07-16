/**
 * Drives the REAL `TASKS submit_workspace` action handler over a REAL
 * CodingWorkspaceService, a REAL git clone, and a local BARE repo served over
 * REAL smart-HTTP (`git http-backend` behind a node:http server): the
 * commit→push pipeline and its error paths run against actual git state under
 * the production `GIT_ALLOW_PROTOCOL=http:https:ssh` allowlist, and every
 * assertion reads that state back (bare-remote refs, git log). The workspace
 * record is injected into the service's registry directly because
 * `provisionWorkspace` hard-rejects local-path remotes by design; everything
 * downstream of provisioning is the production path. The PR leg proves the
 * submit boundary surfaces the underlying finalize failure instead of
 * fabricating a PR.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { tasksAction } from "../actions/tasks.ts";
import { CodingWorkspaceService } from "../services/workspace-service.ts";
import type { WorkspaceResult } from "../services/workspace-types.ts";

const cleanupDirs: string[] = [];
const cleanupServices: CodingWorkspaceService[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Smart-HTTP git host running as a SEPARATE process
 * (`__tests__/fixtures/git-http-host.mjs`): the unit under test pushes with
 * blocking execFileSync, which would deadlock an in-process server sharing
 * this thread's event loop. */
let gitHttp: { child: ChildProcess; root: string; baseUrl: string };

const GIT_HTTP_HOST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "__tests__",
  "fixtures",
  "git-http-host.mjs",
);

async function startGitHttpHost(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "submit-git-http-"));
  const child = spawn(process.execPath, [GIT_HTTP_HOST, root], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("git http host never became ready")),
      15_000,
    );
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/GIT_HTTP_HOST_READY (\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`git http host exited early (code ${code})`));
    });
  });
  gitHttp = { child, root, baseUrl };
}

let repoCounter = 0;

/** Bare repo served over smart HTTP + a working clone of it. */
function makeRepoPair(): { bare: string; remoteUrl: string; work: string } {
  const name = `origin-${++repoCounter}.git`;
  const bare = join(gitHttp.root, name);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  git(bare, "config", "http.receivepack", "true");
  const remoteUrl = `${gitHttp.baseUrl}/${name}`;
  const work = tempDir("submit-work-");
  execFileSync("git", ["clone", "-q", remoteUrl, work]);
  git(work, "config", "user.email", "submit@test.local");
  git(work, "config", "user.name", "Submit Test");
  writeFileSync(join(work, "README.md"), "# seed\n");
  git(work, "add", "README.md");
  git(work, "commit", "-q", "-m", "seed");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "checkout", "-q", "-b", "feat/submit");
  return { bare, remoteUrl, work };
}

beforeAll(async () => {
  await startGitHttpHost();
});

afterAll(async () => {
  gitHttp.child.kill("SIGTERM");
  rmSync(gitHttp.root, { recursive: true, force: true });
});

function makeRuntime(baseDir: string): IAgentRuntime {
  const services = new Map<string, unknown>();
  const runtime = {
    agentId: "00000000-0000-4000-8000-00000000subm",
    character: { name: "Submit" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError: vi.fn(),
    getSetting: (k: string) =>
      k === "CODING_WORKSPACE_CONFIG" ? { baseDir } : undefined,
    getService: (t: string) => services.get(t) ?? null,
    __services: services,
  };
  return runtime as unknown as IAgentRuntime;
}

async function startService(
  runtime: IAgentRuntime,
): Promise<CodingWorkspaceService> {
  const service = await CodingWorkspaceService.start(runtime);
  (runtime as unknown as { __services: Map<string, unknown> }).__services.set(
    "CODING_WORKSPACE_SERVICE",
    service,
  );
  cleanupServices.push(service);
  return service;
}

function registerWorkspace(
  service: CodingWorkspaceService,
  work: string,
  remoteUrl: string,
): WorkspaceResult {
  const result: WorkspaceResult = {
    id: "ws-submit-1",
    path: work,
    branch: "feat/submit",
    baseBranch: "main",
    isWorktree: false,
    repo: remoteUrl,
    status: "ready",
  };
  (
    service as unknown as { workspaces: Map<string, WorkspaceResult> }
  ).workspaces.set(result.id, result);
  return result;
}

function message(): Memory {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    roomId: "55555555-5555-4555-8555-555555555555",
    // Self-originated message (entityId === agentId): the agent finalizing its
    // own workspace, the same fast-path the sub-agent pipeline uses. Keeps the
    // real requireTaskAgentAccess gate in the loop without a roles backend.
    entityId: "00000000-0000-4000-8000-00000000subm",
    content: { text: "submit the workspace", metadata: {} },
  } as unknown as Memory;
}

async function runSubmit(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; replies: string[] }> {
  const replies: string[] = [];
  const result = (await tasksAction.handler(
    runtime,
    message(),
    undefined as unknown as State,
    { parameters: { action: "submit_workspace", ...parameters } },
    async (content) => {
      if (typeof content.text === "string") replies.push(content.text);
      return [];
    },
  )) as Record<string, unknown>;
  return { result, replies };
}

afterEach(async () => {
  for (const service of cleanupServices.splice(0)) {
    await service.stop().catch(() => undefined);
  }
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TASKS submit_workspace (real service, real git, bare remote)", () => {
  it("reports no-changes on a clean workspace without inventing a commit", async () => {
    const { bare, remoteUrl, work } = makeRepoPair();
    const runtime = makeRuntime(tempDir("submit-base-"));
    const service = await startService(runtime);
    registerWorkspace(service, work, remoteUrl);

    const before = git(work, "rev-parse", "HEAD");
    const { result, replies } = await runSubmit(runtime, {
      workspaceId: "ws-submit-1",
      skipPR: true,
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("No changes to commit");
    expect(replies.join("\n")).toContain("No changes to commit");
    // Really nothing happened: HEAD unchanged, no branch on the remote.
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
    expect(
      execFileSync("git", ["branch", "--list", "feat/submit"], {
        cwd: bare,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
  });

  it("commits and pushes dirty changes to the bare remote (skipPR)", async () => {
    const { bare, remoteUrl, work } = makeRepoPair();
    const runtime = makeRuntime(tempDir("submit-base-"));
    const service = await startService(runtime);
    registerWorkspace(service, work, remoteUrl);

    writeFileSync(join(work, "feature.ts"), "export const y = 2;\n");
    const { result, replies } = await runSubmit(runtime, {
      workspaceId: "ws-submit-1",
      commitMessage: "feat: submit pipeline change",
      skipPR: true,
    });

    expect(result.success, JSON.stringify({ result, replies })).toBe(true);
    expect(result.text).toBe("Changes committed and pushed");
    const data = result.data as { commitHash: string; workspaceId: string };
    expect(data.workspaceId).toBe("ws-submit-1");
    // The reported hash is the real new HEAD…
    expect(data.commitHash).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(work, "log", "-1", "--pretty=%B")).toBe(
      "feat: submit pipeline change",
    );
    // …and the bare remote actually received the branch at that commit.
    expect(git(bare, "rev-parse", "refs/heads/feat/submit")).toBe(
      data.commitHash,
    );
    expect(replies.join("\n")).toContain(data.commitHash.slice(0, 8));
  });

  it("surfaces a push rejection as a structured failure, never a phantom success", async () => {
    const { bare, remoteUrl, work } = makeRepoPair();
    const runtime = makeRuntime(tempDir("submit-base-"));
    const service = await startService(runtime);
    registerWorkspace(service, work, remoteUrl);

    // Pre-create the branch on the remote AHEAD of the clone so the push is
    // rejected as non-fast-forward.
    const other = tempDir("submit-other-");
    execFileSync("git", ["clone", "-q", remoteUrl, other]);
    git(other, "config", "user.email", "other@test.local");
    git(other, "config", "user.name", "Other");
    git(other, "checkout", "-q", "-b", "feat/submit");
    writeFileSync(join(other, "ahead.txt"), "ahead\n");
    git(other, "add", "ahead.txt");
    git(other, "commit", "-q", "-m", "remote ahead");
    git(other, "push", "-q", "-u", "origin", "feat/submit");
    const remoteHash = git(bare, "rev-parse", "refs/heads/feat/submit");

    writeFileSync(join(work, "local.txt"), "local\n");
    const { result, replies } = await runSubmit(runtime, {
      workspaceId: "ws-submit-1",
      skipPR: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("FINALIZE_FAILED");
    expect(replies.join("\n")).toContain("Failed to finalize workspace");
    // The remote kept its own commit — the rejected push changed nothing.
    expect(git(bare, "rev-parse", "refs/heads/feat/submit")).toBe(remoteHash);
  });

  it("returns WORKSPACE_NOT_FOUND for an unknown workspace id", async () => {
    const runtime = makeRuntime(tempDir("submit-base-"));
    await startService(runtime);
    const { result } = await runSubmit(runtime, {
      workspaceId: "no-such-workspace",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("WORKSPACE_NOT_FOUND");
  });

  it("PR leg: commit+push land, and the PR-creation failure is surfaced (not a fabricated PR)", async () => {
    // The underlying git-workspace-service has no record of this injected
    // workspace (and no GitHub credential), so createPR's finalize MUST fail;
    // the submit boundary must surface that as FINALIZE_FAILED after the real
    // commit+push already happened — proving the pipeline ran and the error
    // path does not invent a PR.
    const { bare, remoteUrl, work } = makeRepoPair();
    const runtime = makeRuntime(tempDir("submit-base-"));
    const service = await startService(runtime);
    registerWorkspace(service, work, remoteUrl);

    writeFileSync(join(work, "pr-change.ts"), "export const z = 3;\n");
    const { result, replies } = await runSubmit(runtime, {
      workspaceId: "ws-submit-1",
      commitMessage: "feat: pr leg",
      prTitle: "feat: pr leg",
      prBody: "body",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("FINALIZE_FAILED");
    expect(replies.join("\n")).toContain("Failed to finalize workspace");
    // No PR fields anywhere in the failure.
    expect(JSON.stringify(result)).not.toContain('"pr"');
    // The commit+push halves of the pipeline really executed first.
    const pushed = git(bare, "rev-parse", "refs/heads/feat/submit");
    expect(pushed).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(work, "log", "-1", "--pretty=%B")).toBe("feat: pr leg");
  });
});
