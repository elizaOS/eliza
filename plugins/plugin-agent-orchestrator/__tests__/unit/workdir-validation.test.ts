/**
 * resolveAllowedWorkdir is a sandbox boundary: an auto-spawned coding agent may
 * only run inside `~/.eliza/workspaces` or the process cwd. A caller-supplied
 * workdir pointing anywhere else (or one that doesn't exist) must be rejected,
 * so a task can't escape the workspace sandbox.
 */

import { mkdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ensureTaskWorkdir,
  resolveAllowedWorkdir,
} from "../../src/services/workdir-validation.js";

const created: string[] = [];
afterAll(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("ensureTaskWorkdir / resolveAllowedWorkdir", () => {
  it("creates a per-task dir under the workspace base and accepts it", async () => {
    const taskId = `eliza-test-${process.pid}-a`;
    const dir = await ensureTaskWorkdir(taskId);
    created.push(dir);
    expect(dir).toContain(path.join(".eliza", "workspaces", taskId));
    const resolved = await resolveAllowedWorkdir(dir);
    expect(resolved.endsWith(taskId)).toBe(true);
  });

  it("rejects a workdir that does not exist", async () => {
    const missing = path.join(
      os.homedir(),
      ".eliza",
      "workspaces",
      `missing-${process.pid}`,
    );
    await expect(resolveAllowedWorkdir(missing)).rejects.toThrow(/must exist/);
  });

  it("rejects an existing dir outside the workspace base and cwd", async () => {
    // The OS scratch dir exists but lives in neither the workspace base nor cwd.
    await expect(resolveAllowedWorkdir(os.tmpdir())).rejects.toThrow(
      /within workspace base/,
    );
  });

  it("accepts a dir inside the current working directory", async () => {
    const dir = path.join(process.cwd(), `.workdir-test-${process.pid}`);
    await mkdir(dir, { recursive: true });
    created.push(dir);
    const resolved = await resolveAllowedWorkdir(dir);
    expect(resolved.endsWith(path.basename(dir))).toBe(true);
  });

  it("accepts a dir inside a configured workspace root (ELIZA_WORKSPACE_DIR)", async () => {
    // A dir under the OS scratch dir is normally rejected (it is neither the
    // ~/.eliza/workspaces base nor cwd). Pointing a configured workspace root
    // env var at it must make a child dir allowed, matching the spawn path.
    const root = path.join(os.tmpdir(), `eliza-ws-root-${process.pid}`);
    const child = path.join(root, "apps", "some-app");
    await mkdir(child, { recursive: true });
    created.push(root);
    const prev = process.env.ELIZA_WORKSPACE_DIR;
    process.env.ELIZA_WORKSPACE_DIR = root;
    try {
      const resolved = await resolveAllowedWorkdir(child);
      expect(resolved.endsWith(path.join("apps", "some-app"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ELIZA_WORKSPACE_DIR;
      else process.env.ELIZA_WORKSPACE_DIR = prev;
    }
  });

  it("still rejects a dir outside the base, cwd, and any configured root", async () => {
    // With no workspace-root env configured, the OS scratch dir stays rejected.
    const prev = process.env.ELIZA_WORKSPACE_DIR;
    delete process.env.ELIZA_WORKSPACE_DIR;
    try {
      await expect(resolveAllowedWorkdir(os.tmpdir())).rejects.toThrow(
        /within workspace base/,
      );
    } finally {
      if (prev !== undefined) process.env.ELIZA_WORKSPACE_DIR = prev;
    }
  });
});
