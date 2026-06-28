import { mkdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ensureTaskWorkdir,
  resolveAllowedWorkdir,
} from "../../src/services/workdir-validation.js";

/**
 * resolveAllowedWorkdir is a sandbox boundary: an auto-spawned coding agent may
 * only run inside `~/.eliza/workspaces` or the process cwd. A caller-supplied
 * workdir pointing anywhere else (or one that doesn't exist) must be rejected,
 * so a task can't escape the workspace sandbox.
 */

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
    // The OS temp dir exists but lives in neither the workspace base nor cwd.
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
});
