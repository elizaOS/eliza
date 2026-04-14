import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn<(candidate: string) => boolean>();
const spawnMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

function createSpawnedProcess(options: {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  queueMicrotask(() => {
    for (const line of options.stdout ?? []) {
      child.stdout.write(`${line}\n`);
    }
    for (const line of options.stderr ?? []) {
      child.stderr.write(`${line}\n`);
    }
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", options.exitCode ?? 0);
  });

  return child;
}

describe("findStewardEntryPoint", () => {
  afterEach(() => {
    delete process.env.STEWARD_ENTRY_POINT;
    existsSyncMock.mockReset();
    spawnMock.mockReset();
    vi.resetModules();
  });

  it("finds the repo-local embedded steward entry point from process.cwd()", async () => {
    const expected = path.resolve(
      process.cwd(),
      "steward-fi/packages/api/src/embedded.ts",
    );
    existsSyncMock.mockImplementation((candidate) => candidate === expected);

    const { findStewardEntryPoint } = await import("./process-management");
    const result = await findStewardEntryPoint();

    expect(result).toBe(expected);
  });

  it("resolves the steward workspace root from a repo-local entry point", async () => {
    const { resolveStewardWorkspaceRoot } = await import(
      "./process-management"
    );

    expect(
      resolveStewardWorkspaceRoot(
        "/Users/home/milady/steward-fi/packages/api/src/embedded.ts",
      ),
    ).toBe("/Users/home/milady/steward-fi");
  });

  it("retries bootstrap without saving the lockfile when steward-fi has a stale bun.lock", async () => {
    const workspaceRoot = "/Users/home/milady/steward-fi";
    existsSyncMock.mockReturnValue(false);
    spawnMock
      .mockImplementationOnce(() =>
        createSpawnedProcess({
          stderr: ["error: lockfile had changes, but lockfile is frozen"],
          exitCode: 1,
        }),
      )
      .mockImplementationOnce(() =>
        createSpawnedProcess({
          stdout: ["installed"],
          exitCode: 0,
        }),
      );

    const { ensureStewardWorkspaceReady } = await import(
      "./process-management"
    );

    await expect(
      ensureStewardWorkspaceReady(
        `${workspaceRoot}/packages/api/src/embedded.ts`,
      ),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "bun",
      ["install", "--frozen-lockfile"],
      expect.objectContaining({
        cwd: workspaceRoot,
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "bun",
      ["install", "--no-save"],
      expect.objectContaining({
        cwd: workspaceRoot,
      }),
    );
  });
});
