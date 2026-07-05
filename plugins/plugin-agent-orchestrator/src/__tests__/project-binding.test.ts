/**
 * Unit test for task↔Project binding resolution against a REAL on-disk project
 * registry under a temp ELIZA_STATE_DIR (no mocks). Covers explicit-id validation,
 * realpath workdir matching, and bound-project workdir resolution.
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { setActiveProject, upsertProject } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findProjectByWorkdir,
  resolveBoundProjectWorkdir,
  resolveTaskProjectId,
} from "../services/project-binding.ts";

describe("project-binding", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = mkdtempSync(join(os.tmpdir(), "project-binding-"));
    env = { ELIZA_STATE_DIR: stateDir };
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("binds an explicit projectId only when it is registered", () => {
    const p = upsertProject({ name: "a", localPath: "/tmp/a" }, env);
    expect(resolveTaskProjectId({ projectId: p.id }, env)).toBe(p.id);
    expect(resolveTaskProjectId({ projectId: "unregistered" }, env)).toBeUndefined();
  });

  it("binds by realpath match of the workdir against a registered project", () => {
    // Register a real directory, then match a symlink pointing at it.
    const realDir = mkdtempSync(join(os.tmpdir(), "proj-real-"));
    const link = join(stateDir, "link-to-real");
    symlinkSync(realDir, link);
    try {
      const p = upsertProject({ name: "real", localPath: realDir }, env);
      expect(findProjectByWorkdir(link, env)?.id).toBe(p.id);
      expect(resolveTaskProjectId({ workdir: link }, env)).toBe(p.id);
      expect(resolveTaskProjectId({ workdir: "/tmp/nomatch" }, env)).toBeUndefined();
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("explicit projectId beats a conflicting workdir match", () => {
    const a = upsertProject({ name: "a", localPath: realpathSync(os.tmpdir()) }, env);
    const b = upsertProject({ name: "b", localPath: "/tmp/b-somewhere" }, env);
    // workdir matches A's localPath, but explicit id names B.
    expect(
      resolveTaskProjectId({ projectId: b.id, workdir: os.tmpdir() }, env),
    ).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  it("resolveBoundProjectWorkdir returns the registered localPath or null", () => {
    const p = upsertProject({ name: "a", localPath: "/tmp/bound-project" }, env);
    setActiveProject(p.id, env);
    expect(resolveBoundProjectWorkdir(p.id, env)).toBe("/tmp/bound-project");
    expect(resolveBoundProjectWorkdir("stale-id", env)).toBeNull();
    expect(resolveBoundProjectWorkdir(undefined, env)).toBeNull();
  });
});
