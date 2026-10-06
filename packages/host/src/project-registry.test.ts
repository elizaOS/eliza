import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveProject,
  getProjectById,
  projectRegistryPath,
  readProjectRegistry,
  revokeProjectBookmark,
  selectProjectFolder,
  upsertProject,
} from "./utils/project-registry";

const roots: string[] = [];
function environment() {
  const root = mkdtempSync(join(tmpdir(), "eliza-project-registry-"));
  roots.push(root);
  return { ELIZA_STATE_DIR: root };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("project registry reads", () => {
  it("returns absence only for missing state", () => {
    expect(readProjectRegistry(environment())).toBeNull();
  });
  it.each([
    "{",
    '{"version":1,"projects":[]}',
    '{"version":2,"activeProjectId":null,"projects":[]}',
  ])("surfaces invalid persisted state: %s", (raw) => {
    const env = environment();
    writeFileSync(projectRegistryPath(env), raw);
    expect(() => readProjectRegistry(env)).toThrow(
      expect.objectContaining({ code: "PROJECT_REGISTRY_INVALID" }),
    );
  });
  it("does not disguise an unreadable registry as first-run absence", () => {
    const env = environment();
    mkdirSync(projectRegistryPath(env));
    expect(() => readProjectRegistry(env)).toThrow(
      expect.objectContaining({ code: "PROJECT_REGISTRY_READ_FAILED" }),
    );
  });
});

it("imports a complete workspace selection once and retains bound project ids", () => {
  const env = environment();
  const source = join(env.ELIZA_STATE_DIR, "workspace-folder.json");
  const selection = {
    path: "/workspace/🟠",
    bookmark: "complete native bookmark 🙂".repeat(100),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(source, JSON.stringify(selection));
  const first = readProjectRegistry(env);
  if (!first?.activeProjectId) throw new Error("Selection was not imported");
  expect(first.activeProjectId).toBe("legacy-ac322657db2169f0");
  expect(first.projects[0]).toMatchObject({
    localPath: selection.path,
    bookmark: selection.bookmark,
    createdAt: selection.updatedAt,
    lastOpenedAt: selection.updatedAt,
  });
  expect(existsSync(source)).toBe(false);
  expect(JSON.parse(readFileSync(projectRegistryPath(env), "utf8"))).toEqual(
    first,
  );
  expect(readProjectRegistry(env)).toEqual(first);
  expect(getProjectById(first.activeProjectId, env)).toEqual(first.projects[0]);
});

it.each(["{", JSON.stringify({ path: 42, bookmark: null, updatedAt: "now" })])(
  "preserves invalid selection data: %s",
  (raw) => {
    const env = environment(),
      source = join(env.ELIZA_STATE_DIR, "workspace-folder.json");
    writeFileSync(source, raw);
    expect(() => readProjectRegistry(env)).toThrow(
      expect.objectContaining({ code: "PROJECT_SELECTION_INVALID" }),
    );
    expect(readFileSync(source, "utf8")).toBe(raw);
    expect(existsSync(projectRegistryPath(env))).toBe(false);
  },
);

it("preserves project bindings while selecting, restoring, and revoking a bookmark", () => {
  const env = environment();
  const bound = upsertProject(
    {
      name: "User project name",
      localPath: join(env.ELIZA_STATE_DIR, "original"),
      bookmark: "opaque",
      repoUrl: "https://example.com/project",
      defaultBranch: "develop",
      cloudAppId: "app-binding",
      worldId: "world-binding",
    },
    env,
  );
  const selected = selectProjectFolder(bound.localPath, "opaque", env);
  expect(selected).toMatchObject({
    ...bound,
    lastOpenedAt: selected.lastOpenedAt,
  });
  expect(getActiveProject(env)?.id).toBe(bound.id);
  const relocated = selectProjectFolder(
    join(env.ELIZA_STATE_DIR, "renamed"),
    "opaque",
    env,
  );
  expect(relocated).toMatchObject({
    id: bound.id,
    name: bound.name,
    createdAt: bound.createdAt,
    cloudAppId: bound.cloudAppId,
    worldId: bound.worldId,
    repoUrl: bound.repoUrl,
    defaultBranch: bound.defaultBranch,
  });
  const other = selectProjectFolder(
    join(env.ELIZA_STATE_DIR, "other"),
    "other-bookmark",
    env,
  );
  revokeProjectBookmark("opaque", env);
  expect(getActiveProject(env)?.id).toBe(other.id);
  expect(getProjectById(bound.id, env)).toMatchObject({
    id: bound.id,
    bookmark: null,
    cloudAppId: "app-binding",
    localPath: relocated.localPath,
  });
  revokeProjectBookmark("other-bookmark", env);
  expect(getActiveProject(env)).toBeNull();
  expect(readProjectRegistry(env)?.projects).toHaveLength(2);
  revokeProjectBookmark("other-bookmark", env);
  expect(getActiveProject(env)).toBeNull();
});

it("rejects bookmark path collisions without changing either project", () => {
  const env = environment();
  selectProjectFolder(
    join(env.ELIZA_STATE_DIR, "first"),
    "first-bookmark",
    env,
  );
  const other = selectProjectFolder(
    join(env.ELIZA_STATE_DIR, "second"),
    "second-bookmark",
    env,
  );
  const before = readProjectRegistry(env);
  expect(() =>
    selectProjectFolder(other.localPath, "first-bookmark", env),
  ).toThrow(expect.objectContaining({ code: "PROJECT_PATH_CONFLICT" }));
  expect(readProjectRegistry(env)).toEqual(before);
});
