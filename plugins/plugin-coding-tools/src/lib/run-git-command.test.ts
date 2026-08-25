import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { __setCapabilityRouter, CapabilityError } from "@elizaos/core";
import { GitCommandExecutionError, runGitCommand } from "./run-git-command";

const execFileMock = vi.mocked(execFile);
const runtime = {} as never;

function localSuccess(out: string, err: string) {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null as never, { stdout: out, stderr: err } as never);
  });
}

function localFailure(error: Error) {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(error as never);
  });
}

function routerReturning(operation: Record<string, unknown>) {
  __setCapabilityRouter({
    git: {
      commandRun: vi.fn(async () => ({ operation })),
    },
  });
}

function routerThrowing(error: Error) {
  __setCapabilityRouter({
    git: {
      commandRun: vi.fn(async () => {
        throw error;
      }),
    },
  });
}

const OPTS = { cwd: "/tmp/w", args: ["status"], timeoutMs: 5000 };

describe("runGitCommand capability routing", () => {
  beforeEach(() => {
    __setCapabilityRouter(null);
    execFileMock.mockReset();
  });

  it("falls back to local git when no capability router is registered", async () => {
    localSuccess("out", "err");
    const result = await runGitCommand(runtime, OPTS);
    expect(result).toEqual({
      routed: false,
      stdout: "out",
      stderr: "err",
      exitCode: 0,
      signal: null,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({
        cwd: "/tmp/w",
        encoding: "utf8",
        timeout: 5000,
      }),
      expect.any(Function),
    );
  });

  it("returns the routed operation result when the router succeeds", async () => {
    routerReturning({
      status: "succeeded",
      exitCode: 0,
      stdout: "routed-out",
      stderr: "",
      signal: null,
    });
    const result = await runGitCommand(runtime, OPTS);
    expect(result).toEqual({
      routed: true,
      stdout: "routed-out",
      stderr: "",
      exitCode: 0,
      signal: null,
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("degrades to local git when the router reports CAPABILITY_UNAVAILABLE", async () => {
    routerThrowing(
      new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "git capability is not available",
      }),
    );
    localSuccess("fallback-out", "");
    const result = await runGitCommand(runtime, OPTS);
    expect(result.routed).toBe(false);
    expect(result.stdout).toBe("fallback-out");
  });

  it("rethrows non-availability router errors instead of masking them", async () => {
    const denied = new CapabilityError({
      code: "CAPABILITY_DENIED",
      message: "git access denied by host policy",
    });
    routerThrowing(denied);
    await expect(runGitCommand(runtime, OPTS)).rejects.toBe(denied);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rethrows arbitrary router errors so real git failures surface", async () => {
    const boom = new Error("router exploded");
    routerThrowing(boom);
    await expect(runGitCommand(runtime, OPTS)).rejects.toBe(boom);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("throws a typed error when the routed operation reports failure", async () => {
    routerReturning({
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: "fatal: not a git repository",
      error: "git operation rejected by capability",
      signal: null,
    });
    await expect(runGitCommand(runtime, OPTS)).rejects.toMatchObject({
      name: "GitCommandExecutionError",
      message: "git operation rejected by capability",
      stderr: "fatal: not a git repository",
    });
  });

  it("throws a typed error when the routed operation exits non-zero", async () => {
    routerReturning({
      status: "succeeded",
      exitCode: 2,
      stdout: "",
      stderr: "error: pathspec did not match",
      signal: null,
    });
    await expect(runGitCommand(runtime, OPTS)).rejects.toMatchObject({
      name: "GitCommandExecutionError",
      message: "git exited with status 2",
      stderr: "error: pathspec did not match",
    });
  });

  it("propagates local git execution failures (e.g. timeout)", async () => {
    const timedOut = new Error("ETIMEDOUT");
    timedOut.name = "TimeoutError";
    localFailure(timedOut);
    await expect(runGitCommand(runtime, OPTS)).rejects.toBe(timedOut);
  });

  it("builds GitCommandExecutionError with stderr and stable name", () => {
    const err = new GitCommandExecutionError("boom", "stderr-content");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitCommandExecutionError");
    expect(err.stderr).toBe("stderr-content");
  });
});
