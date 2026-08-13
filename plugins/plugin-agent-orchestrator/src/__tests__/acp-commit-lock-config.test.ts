/**
 * The session git wrapper's commit-lock timings come from ACP_COMMIT_LOCK_*
 * env vars. Parsing them with parseInt was lenient in both directions:
 *
 *   - "abc" -> NaN. `Date.now() >= NaN` is false, so the acquire deadline never
 *     trips, and Atomics.wait coerces a NaN timeout to +Infinity, so the poll
 *     sleep blocks forever. A contended commit hung the wrapper permanently
 *     instead of timing out.
 *   - "2m"  -> 2. A 2ms acquire deadline looks valid and silently disables the
 *     cross-process serialization the lock exists to provide, reopening the
 *     #14183 silent-revert window.
 *
 * These drive the real wrapper against a genuinely contended lock and assert it
 * still honors a bounded deadline. Without the strict parse the first case does
 * not fail — it never returns.
 */

import type { ChildProcess } from "node:child_process";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

type WrapperResult = { code: number; stderr: string };
type WrapperRun = { child: ChildProcess; result: Promise<WrapperResult> };

/** Runs `args` through the session git wrapper on the session env's PATH. */
function wrapperGit(
  repo: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): WrapperRun {
  const wrapperDir = env.PATH?.split(path.delimiter)[0];
  if (!wrapperDir) throw new Error("ACP git wrapper directory is missing");
  const wrapper = path.join(wrapperDir, "git");
  const interpreter = readFileSync(wrapper, "utf8").split("\n", 1)[0]?.slice(2);
  if (!interpreter) throw new Error("ACP git wrapper interpreter is missing");
  let resolveResult: (result: WrapperResult) => void = () => undefined;
  const result = new Promise<WrapperResult>((resolve) => {
    resolveResult = resolve;
  });
  const child = execFile(
    interpreter,
    [wrapper, "-C", repo, ...args],
    { env },
    (err, _stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code ?? 1)
          : err
            ? 1
            : 0;
      resolveResult({ code, stderr: stderr ?? "" });
    },
  );
  return { child, result };
}

/** A live process whose PID keeps the planted lock unstealable. */
function spawnLiveChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill();
  await exited;
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | "still-waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"still-waiting">((resolve) => {
        timer = setTimeout(() => resolve("still-waiting"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type GitIndexPreparer = {
  prepareSessionGitIndex(
    workdir: string,
    sessionId: string,
    baselineSha?: string,
  ): Promise<{ env: Record<string, string> } | undefined>;
};

describe("ACP commit-lock env parsing", () => {
  let tmpRoot: string;
  let repo: string;
  let holder: ChildProcess | undefined;
  let wrapperRuns: WrapperRun[];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "acp-lock-config-"));
    wrapperRuns = [];
    repo = path.join(tmpRoot, "repo");
    git(tmpRoot, ["init", repo]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "ACP Test"]);
    writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
  });

  afterEach(async () => {
    for (const run of wrapperRuns) {
      await stopChild(run.child);
      await run.result;
    }
    if (holder) await stopChild(holder);
    holder = undefined;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function startWrapper(args: string[], env: NodeJS.ProcessEnv): WrapperRun {
    const run = wrapperGit(repo, args, env);
    wrapperRuns.push(run);
    return run;
  }

  /** Plants a fresh, live-PID-owned lock so the wrapper must wait, then poll. */
  async function contendedSessionEnv(
    overrides: NodeJS.ProcessEnv,
  ): Promise<NodeJS.ProcessEnv> {
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const prepare = (
      service as unknown as GitIndexPreparer
    ).prepareSessionGitIndex.bind(service);
    const session = await prepare(
      repo,
      `${path.basename(tmpRoot)}-sess`,
      git(repo, ["rev-parse", "HEAD"]),
    );
    if (!session?.env.GIT_INDEX_FILE) {
      throw new Error("session git index was not prepared");
    }

    holder = spawnLiveChild();
    writeFileSync(
      path.join(repo, ".git", "eliza-acp-commit.lock"),
      JSON.stringify({
        pid: holder.pid,
        token: "held-by-test",
        createdAt: Date.now(),
      }),
    );

    writeFileSync(path.join(repo, "contended.txt"), "contended\n");
    git(repo, ["add", "contended.txt"], session.env);
    return { ...process.env, ...session.env, ...overrides };
  }

  it("falls back to the default poll interval when the value is unparseable", async () => {
    // Pre-fix this never returns: NaN poll -> Atomics.wait(+Infinity).
    const env = await contendedSessionEnv({
      ACP_COMMIT_LOCK_POLL_MS: "abc",
      ACP_COMMIT_LOCK_WAIT_MS: "400",
    });

    const started = Date.now();
    const result = await startWrapper(["commit", "-m", "contended"], env)
      .result;

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("timed out acquiring commit lock");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("ignores a unit-suffixed wait rather than truncating it to milliseconds", async () => {
    // "2m" parsed as 2ms would time out almost immediately, silently dropping
    // the serialization guarantee. The strict parse falls back to 120s, so the
    // wrapper is still waiting when we cut it off.
    const env = await contendedSessionEnv({
      ACP_COMMIT_LOCK_POLL_MS: "25",
      ACP_COMMIT_LOCK_WAIT_MS: "2m",
    });

    const run = startWrapper(["commit", "-m", "contended"], env);
    const outcome = await settleWithin(run.result, 1_500);

    expect(outcome).toBe("still-waiting");
    await stopChild(run.child);
    await run.result;
  }, 30_000);

  it("bounds an accepted long poll by a shorter acquisition deadline", async () => {
    const env = await contendedSessionEnv({
      ACP_COMMIT_LOCK_POLL_MS: "2147483647",
      ACP_COMMIT_LOCK_WAIT_MS: "100",
    });

    const started = Date.now();
    const run = startWrapper(["commit", "-m", "contended"], env);
    const outcome = await settleWithin(run.result, 5_000);

    if (outcome === "still-waiting") {
      throw new Error(
        "wrapper exceeded the configured lock acquisition deadline",
      );
    }
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain("timed out acquiring commit lock");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("falls back when a timing exceeds the supported millisecond range", async () => {
    const env = await contendedSessionEnv({
      ACP_COMMIT_LOCK_POLL_MS: String(Number.MAX_SAFE_INTEGER),
      ACP_COMMIT_LOCK_WAIT_MS: "100",
    });

    const result = await startWrapper(["commit", "-m", "contended"], env)
      .result;

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("timed out acquiring commit lock");
  }, 10_000);

  it("honors valid overrides", async () => {
    const env = await contendedSessionEnv({
      ACP_COMMIT_LOCK_POLL_MS: "10",
      ACP_COMMIT_LOCK_WAIT_MS: "300",
    });

    const started = Date.now();
    const result = await startWrapper(["commit", "-m", "contended"], env)
      .result;

    expect(result.stderr).toContain("timed out acquiring commit lock");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
