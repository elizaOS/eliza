import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn(() => {
      const { EventEmitter } = require("events");
      const { Readable } = require("stream");
      const child = new EventEmitter();
      child.stdout = new Readable({
        read() {
          this.push(null);
        },
      });
      child.stderr = new Readable({
        read() {
          this.push(null);
        },
      });
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    }),
  };
});

import { execFile, spawn } from "child_process";
import { ensureVerifyCheckpoint, getVerifyCheckpointName } from "./checkpoint";
import { inferVerifyProjectProfile } from "./entrypoint";

const execFileMock = vi.mocked(execFile);
const spawnMock = vi.mocked(spawn);
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const { EventEmitter } = require("events");
    const { Readable } = require("stream");
    const child = new EventEmitter();
    child.stdout = new Readable({
      read() {
        this.push(null);
      },
    });
    child.stderr = new Readable({
      read() {
        this.push(null);
      },
    });
    setTimeout(() => child.emit("close", 0), 0);
    return child;
  });
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("verify checkpoints", () => {
  it("skips checkpoint creation when no install commands are needed", async () => {
    const dir = makeTempDir("grok-verify-ckpt-go-");
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/demo\n");
    const profile = inferVerifyProjectProfile(dir);

    const result = await ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings);
    expect(result).toEqual({ created: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("creates a deterministic checkpoint for install-based recipes", async () => {
    const dir = makeTempDir("grok-verify-ckpt-node-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      if (Array.isArray(args) && args[0] === "checkpoint" && args[1] === "list") {
        cb(null, "", "");
        return {} as never;
      }
      cb(null, "", "");
      return {} as never;
    });

    const profile = inferVerifyProjectProfile(dir);
    const result = await ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings);

    expect(result.created).toBe(true);
    expect(result.checkpointName).toMatch(/^verify-nextjs-/);
    expect(result.guestWorkdir).toBe("/grok/verify/worktree");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnMock.mock.calls[0];
    expect(spawnArgs[0]).toBe("shuru");
    const createArgs = spawnArgs[1] as string[];
    expect(createArgs.slice(0, 3)).toEqual(["checkpoint", "create", result.checkpointName!]);
    expect(createArgs.join(" ")).toContain("export DEBIAN_FRONTEND=noninteractive");
  });

  it("reuses an existing checkpoint when present", async () => {
    const dir = makeTempDir("grok-verify-ckpt-existing-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");
    const profile = inferVerifyProjectProfile(dir);
    const checkpointName = getVerifyCheckpointName(dir, profile.recipe);

    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      if (Array.isArray(args) && args[0] === "checkpoint" && args[1] === "list") {
        cb(null, `${checkpointName}\n`, "");
        return {} as never;
      }
      cb(null, "", "");
      return {} as never;
    });

    const result = await ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings);

    expect(result.created).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("deletes a failed checkpoint when bootstrap/install fails", async () => {
    const dir = makeTempDir("grok-verify-ckpt-fail-");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }, null, 2));
    fs.writeFileSync(path.join(dir, "bun.lock"), "");
    const profile = inferVerifyProjectProfile(dir);
    const checkpointName = getVerifyCheckpointName(dir, profile.recipe);

    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      if (Array.isArray(args) && args[0] === "checkpoint" && args[1] === "list") {
        cb(null, "", "");
        return {} as never;
      }
      if (Array.isArray(args) && args[0] === "checkpoint" && args[1] === "delete") {
        cb(null, "", "");
        return {} as never;
      }
      cb(null, "", "");
      return {} as never;
    });

    spawnMock.mockImplementation(() => {
      const { EventEmitter } = require("events");
      const { Readable } = require("stream");
      const child = new EventEmitter();
      child.stdout = new Readable({
        read() {
          this.push(null);
        },
      });
      child.stderr = new Readable({
        read() {
          this.push("bun: not found\n");
          this.push(null);
        },
      });
      setTimeout(() => child.emit("close", 1), 0);
      return child;
    });

    await expect(ensureVerifyCheckpoint(dir, profile, profile.sandboxSettings)).rejects.toThrow(
      `Verify checkpoint bootstrap failed for "${checkpointName}"`,
    );
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(["checkpoint", "delete", checkpointName]);
  });
});
