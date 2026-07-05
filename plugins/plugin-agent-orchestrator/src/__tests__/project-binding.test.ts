/**
 * Unit test for task↔Project binding resolution against a REAL on-disk project
 * registry under a temp ELIZA_STATE_DIR (no mocks). Covers explicit-id validation,
 * realpath workdir matching, and bound-project workdir resolution.
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  getProjectById,
  logger,
  setActiveProject,
  stringToUuid,
  upsertProject,
  writeWorkspaceFolderConfig,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindProjectCloudApp,
  deriveProjectWorldId,
  findProjectByWorkdir,
  resolveBoundProjectCloudAppId,
  resolveBoundProjectWorkdir,
  resolveTaskProjectId,
  resolveTaskSpawnWorkdir,
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
    expect(
      resolveTaskProjectId({ projectId: "unregistered" }, env),
    ).toBeUndefined();
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
      expect(
        resolveTaskProjectId({ workdir: "/tmp/nomatch" }, env),
      ).toBeUndefined();
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("explicit projectId beats a conflicting workdir match", () => {
    const a = upsertProject(
      { name: "a", localPath: realpathSync(os.tmpdir()) },
      env,
    );
    const b = upsertProject({ name: "b", localPath: "/tmp/b-somewhere" }, env);
    // workdir matches A's localPath, but explicit id names B.
    expect(
      resolveTaskProjectId({ projectId: b.id, workdir: os.tmpdir() }, env),
    ).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  it("resolveBoundProjectWorkdir returns the registered localPath or null", () => {
    const p = upsertProject(
      { name: "a", localPath: "/tmp/bound-project" },
      env,
    );
    setActiveProject(p.id, env);
    expect(resolveBoundProjectWorkdir(p.id, env)).toBe("/tmp/bound-project");
    expect(resolveBoundProjectWorkdir("stale-id", env)).toBeNull();
    expect(resolveBoundProjectWorkdir(undefined, env)).toBeNull();
  });

  describe("resolveTaskSpawnWorkdir precedence (#14108)", () => {
    it("a project binding beats an explicit caller workdir, LOCKED", () => {
      const p = upsertProject(
        { name: "proj", localPath: "/tmp/the-project" },
        env,
      );
      const r = resolveTaskSpawnWorkdir(
        { projectId: p.id, explicitWorkdir: "/tmp/somewhere-else" },
        env,
      );
      expect(r).toEqual({
        workdir: "/tmp/the-project",
        lockWorkdir: true,
        source: "project",
      });
    });

    it("logs LOUDLY (not silently) when an explicit workdir loses to a project binding", () => {
      const p = upsertProject(
        { name: "proj", localPath: "/tmp/the-project" },
        env,
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      try {
        resolveTaskSpawnWorkdir(
          { projectId: p.id, explicitWorkdir: "/tmp/somewhere-else" },
          env,
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain("workdir-precedence");
        expect(String(warn.mock.calls[0]?.[0])).toContain(
          "/tmp/somewhere-else",
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("does NOT warn when the explicit workdir already equals the project localPath", () => {
      const p = upsertProject(
        { name: "proj", localPath: realpathSync(os.tmpdir()) },
        env,
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      try {
        const r = resolveTaskSpawnWorkdir(
          { projectId: p.id, explicitWorkdir: os.tmpdir() },
          env,
        );
        expect(r.source).toBe("project");
        expect(r.lockWorkdir).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("an explicit caller workdir beats the first-spawn bound pin (not locked)", () => {
      const r = resolveTaskSpawnWorkdir(
        { boundWorkdir: "/tmp/pinned", explicitWorkdir: "/tmp/explicit" },
        env,
      );
      expect(r).toEqual({
        workdir: "/tmp/explicit",
        lockWorkdir: false,
        source: "explicit",
      });
    });

    it("falls back to the bound pin when neither project nor explicit is present", () => {
      const r = resolveTaskSpawnWorkdir({ boundWorkdir: "/tmp/pinned" }, env);
      expect(r).toEqual({
        workdir: "/tmp/pinned",
        lockWorkdir: false,
        source: "bound",
      });
    });

    it("returns unresolved (undefined) when nothing is bound or explicit", () => {
      const r = resolveTaskSpawnWorkdir({}, env);
      expect(r).toEqual({
        workdir: undefined,
        lockWorkdir: false,
        source: "unresolved",
      });
    });

    it("a stale/unregistered projectId does not force a workdir — explicit still wins", () => {
      const r = resolveTaskSpawnWorkdir(
        {
          projectId: "unregistered",
          explicitWorkdir: "/tmp/explicit",
          boundWorkdir: "/tmp/pinned",
        },
        env,
      );
      expect(r.source).toBe("explicit");
      expect(r.workdir).toBe("/tmp/explicit");
      expect(r.lockWorkdir).toBe(false);
    });
  });

  it("deriveProjectWorldId is deterministic in the project id and matches the stringToUuid convention", () => {
    // #13776 D3: the world must be reproducible from the id alone so the agent
    // runtime, desktop picker, and bind seam all land on the same partition
    // without coordinating through disk.
    const a = deriveProjectWorldId("proj-1");
    expect(deriveProjectWorldId("proj-1")).toBe(a);
    expect(deriveProjectWorldId("proj-2")).not.toBe(a);
    expect(a).toBe(stringToUuid("project:proj-1"));
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("resolveBoundProjectCloudAppId returns the project's cloudAppId or null", () => {
    const withApp = upsertProject(
      { name: "with-app", localPath: "/tmp/with-app", cloudAppId: "app_123" },
      env,
    );
    const noApp = upsertProject(
      { name: "no-app", localPath: "/tmp/no-app" },
      env,
    );
    expect(resolveBoundProjectCloudAppId(withApp.id, env)).toBe("app_123");
    expect(resolveBoundProjectCloudAppId(noApp.id, env)).toBeNull();
    expect(resolveBoundProjectCloudAppId("stale-id", env)).toBeNull();
    expect(resolveBoundProjectCloudAppId(undefined, env)).toBeNull();
  });

  it("bindProjectCloudApp writes cloudAppId back and persists it atomically", () => {
    const p = upsertProject({ name: "p", localPath: "/tmp/bind-app" }, env);
    expect(getProjectById(p.id, env)?.cloudAppId).toBeUndefined();

    const bound = bindProjectCloudApp(p.id, "app_new", env);
    expect(bound?.cloudAppId).toBe("app_new");
    // Persisted to disk: a fresh read (new registry parse) sees the id, other
    // fields (id/localPath/createdAt) are preserved by the localPath-keyed upsert.
    const reread = getProjectById(p.id, env);
    expect(reread?.cloudAppId).toBe("app_new");
    expect(reread?.id).toBe(p.id);
    expect(reread?.localPath).toBe("/tmp/bind-app");
    expect(reread?.createdAt).toBe(p.createdAt);
  });

  it("bindProjectCloudApp overwrites a different existing cloudAppId (latest create wins)", () => {
    const p = upsertProject(
      { name: "p", localPath: "/tmp/rebind", cloudAppId: "app_old" },
      env,
    );
    const bound = bindProjectCloudApp(p.id, "app_replacement", env);
    expect(bound?.cloudAppId).toBe("app_replacement");
    expect(getProjectById(p.id, env)?.cloudAppId).toBe("app_replacement");
  });

  it("bindProjectCloudApp is a no-op for an unknown project or blank app id", () => {
    const p = upsertProject(
      { name: "p", localPath: "/tmp/noop", cloudAppId: "app_keep" },
      env,
    );
    expect(bindProjectCloudApp("stale-id", "app_x", env)).toBeNull();
    expect(bindProjectCloudApp(p.id, "  ", env)).toBeNull();
    expect(bindProjectCloudApp(undefined, "app_x", env)).toBeNull();
    // The existing binding is untouched by the no-op calls.
    expect(getProjectById(p.id, env)?.cloudAppId).toBe("app_keep");
  });

  it("a projectId bound via the legacy workspace-folder.json synthesis resolves back to its workdir", () => {
    // Migration window: workspace-folder.json exists, projects.json does not.
    // The synthesized registry is minted fresh on every read, so the bind
    // (createTask) and the later resolve (follow-up spawn) see two separate
    // syntheses — the id must be stable between them or the #13776
    // bound-workdir lock silently no-ops for every legacy install.
    const legacyDir = mkdtempSync(join(os.tmpdir(), "legacy-workdir-"));
    try {
      writeWorkspaceFolderConfig({ path: legacyDir, bookmark: null }, env);

      const bound = resolveTaskProjectId({ workdir: legacyDir }, env);
      expect(bound).toBeTruthy();
      expect(resolveTaskProjectId({ workdir: legacyDir }, env)).toBe(bound);
      expect(resolveBoundProjectWorkdir(bound, env)).toBe(legacyDir);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
