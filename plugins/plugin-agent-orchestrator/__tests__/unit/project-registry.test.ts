/**
 * Verifies the ProjectRegistry: CRUD, active-project pointer, path migration,
 * and JSON persistence. Runs against a real temporary filesystem; deterministic.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileProjectRegistry,
  InMemoryProjectRegistry,
  ProjectRegistry,
} from "../../src/services/project-registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "project-registry-"));
  tempDirs.push(dir);
  return join(dir, "projects.json");
}

describe("ProjectRegistry backend selection", () => {
  it("defaults to the file backend", () => {
    expect(new ProjectRegistry({ stateFile: "/tmp/x.json" }).backend).toBe(
      "file",
    );
  });

  it("uses the memory backend when requested", () => {
    expect(new ProjectRegistry({ backend: "memory" }).backend).toBe("memory");
  });
});

describe("InMemoryProjectRegistry", () => {
  it("creates a project with orchestrator defaults and mints an id", async () => {
    const registry = new InMemoryProjectRegistry();
    const project = await registry.createProject({
      name: "Eliza",
      localPath: "/repos/eliza",
      repoUrl: "https://github.com/elizaOS/eliza",
      defaultBranch: "develop",
      worldId: "world-eliza",
    });
    expect(project.id).toMatch(/[0-9a-f-]{36}/);
    expect(project.name).toBe("Eliza");
    expect(project.localPath).toBe("/repos/eliza");
    expect(project.defaultBranch).toBe("develop");
    expect(project.worldId).toBe("world-eliza");
    expect(project.metadata).toEqual({});
  });

  it("makes the first created project active automatically", async () => {
    const registry = new InMemoryProjectRegistry();
    const first = await registry.createProject({ name: "first" });
    await registry.createProject({ name: "second" });
    expect(await registry.getActiveProjectId()).toBe(first.id);
    expect((await registry.getActiveProject())?.name).toBe("first");
  });

  it("returns cloned projects so callers cannot mutate stored state", async () => {
    const registry = new InMemoryProjectRegistry();
    const created = await registry.createProject({ name: "immutable" });
    const fetched = await registry.getProject(created.id);
    if (!fetched) throw new Error("expected project");
    fetched.name = "mutated";
    expect((await registry.getProject(created.id))?.name).toBe("immutable");
  });

  it("lists projects oldest-first", async () => {
    const registry = new InMemoryProjectRegistry();
    const a = await registry.createProject({ name: "a" });
    const b = await registry.createProject({ name: "b" });
    const listed = await registry.listProjects();
    expect(listed.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("updates mutable fields and bumps updatedAt, preserving id/createdAt", async () => {
    const registry = new InMemoryProjectRegistry();
    const created = await registry.createProject({ name: "before" });
    const updated = await registry.updateProject(created.id, {
      name: "after",
      defaultBranch: "main",
    });
    expect(updated?.id).toBe(created.id);
    expect(updated?.name).toBe("after");
    expect(updated?.defaultBranch).toBe("main");
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(
      updated && updated.updatedAt >= created.updatedAt,
    ).toBe(true);
  });

  it("returns null when updating an unknown project", async () => {
    const registry = new InMemoryProjectRegistry();
    expect(await registry.updateProject("nope", { name: "x" })).toBeNull();
  });

  it("throws when activating an unknown project", async () => {
    const registry = new InMemoryProjectRegistry();
    await expect(registry.setActiveProject("ghost")).rejects.toThrow(
      /unknown project ghost/,
    );
  });

  it("switches the active project between registered projects", async () => {
    const registry = new InMemoryProjectRegistry();
    const a = await registry.createProject({ name: "a" });
    const b = await registry.createProject({ name: "b" });
    expect(await registry.getActiveProjectId()).toBe(a.id);
    await registry.setActiveProject(b.id);
    expect(await registry.getActiveProjectId()).toBe(b.id);
  });

  it("re-points active to a survivor when the active project is removed", async () => {
    const registry = new InMemoryProjectRegistry();
    const a = await registry.createProject({ name: "a" });
    const b = await registry.createProject({ name: "b" });
    await registry.setActiveProject(a.id);
    expect(await registry.removeProject(a.id)).toBe(true);
    expect(await registry.getProject(a.id)).toBeNull();
    expect(await registry.getActiveProjectId()).toBe(b.id);
  });

  it("clears the active pointer when the last project is removed", async () => {
    const registry = new InMemoryProjectRegistry();
    const only = await registry.createProject({ name: "only" });
    await registry.removeProject(only.id);
    expect(await registry.getActiveProjectId()).toBeUndefined();
    expect(await registry.getActiveProject()).toBeNull();
  });

  it("removeProject reports false for an unknown id", async () => {
    const registry = new InMemoryProjectRegistry();
    expect(await registry.removeProject("nope")).toBe(false);
  });
});

describe("ProjectRegistry.ensureProjectForPath (single-folder migration)", () => {
  it("registers a project for a new path, defaulting the name to its basename", async () => {
    const registry = new InMemoryProjectRegistry();
    const project = await registry.ensureProjectForPath("/repos/milady");
    expect(project.localPath).toBe("/repos/milady");
    expect(project.name).toBe("milady");
    expect((await registry.listProjects()).length).toBe(1);
  });

  it("is idempotent: the same path resolves to the same project", async () => {
    const registry = new InMemoryProjectRegistry();
    const first = await registry.ensureProjectForPath("/repos/milady");
    const second = await registry.ensureProjectForPath("/repos/milady");
    expect(second.id).toBe(first.id);
    expect((await registry.listProjects()).length).toBe(1);
  });

  it("honors an explicit name override", async () => {
    const registry = new InMemoryProjectRegistry();
    const project = await registry.ensureProjectForPath(
      "/repos/x",
      "Custom Name",
    );
    expect(project.name).toBe("Custom Name");
  });
});

describe("FileProjectRegistry persistence", () => {
  it("round-trips the full snapshot including the active pointer", async () => {
    const path = await tempFile();
    const writer = new FileProjectRegistry(path);
    const a = await writer.createProject({
      name: "a",
      localPath: "/repos/a",
      worldId: "world-a",
    });
    const b = await writer.createProject({ name: "b" });
    await writer.setActiveProject(b.id);

    const reader = new FileProjectRegistry(path);
    const listed = await reader.listProjects();
    expect(listed.map((p) => p.name)).toEqual(["a", "b"]);
    expect((await reader.getProject(a.id))?.worldId).toBe("world-a");
    expect(await reader.getActiveProjectId()).toBe(b.id);
  });

  it("drops the active pointer if it references a project no longer present", async () => {
    const path = await tempFile();
    const writer = new FileProjectRegistry(path);
    const a = await writer.createProject({ name: "a" });
    const b = await writer.createProject({ name: "b" });
    await writer.setActiveProject(b.id);
    await writer.removeProject(a.id);

    const reader = new FileProjectRegistry(path);
    expect(await reader.getActiveProjectId()).toBe(b.id);
    expect((await reader.listProjects()).map((p) => p.name)).toEqual(["b"]);
  });

  it("starts empty when the registry file does not exist yet", async () => {
    const path = await tempFile();
    const reader = new FileProjectRegistry(path);
    expect(await reader.listProjects()).toEqual([]);
    expect(await reader.getActiveProjectId()).toBeUndefined();
  });
});
