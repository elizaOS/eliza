/**
 * Verifies the ProjectRegistry create/list/resolve surface and its tiered
 * backend selection (#13776). Runs against real temp files and an in-process
 * SQL adapter fake; deterministic, no live DB.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileProjectStore,
  InMemoryProjectStore,
  ProjectRegistry,
  RuntimeDbProjectStore,
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

/** Faithful in-memory emulation of the narrow SQL surface
 * {@link RuntimeDbProjectStore} relies on: an id-keyed row table plus the
 * specific WHERE/ORDER BY/LIMIT shapes it issues. */
class ProjectsFakeSqlAdapter {
  readonly rows = new Map<string, Record<string, unknown>>();

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const head = sql.trim().slice(0, 6).toUpperCase();
    if (head === "CREATE") return;
    if (head === "INSERT") {
      const [id, name, rootDir, createdAt] = params;
      this.rows.set(id as string, {
        id,
        name,
        root_dir: rootDir,
        created_at: createdAt,
      });
    }
  }

  async all(sql: string, params: unknown[] = []): Promise<unknown[]> {
    let rows = [...this.rows.values()];
    if (sql.includes("WHERE id = ?")) {
      return rows.filter((row) => row.id === params[0]);
    }
    if (sql.includes("WHERE root_dir = ?")) {
      rows = rows.filter((row) => row.root_dir === params[0]);
    }
    rows.sort((a, b) =>
      String(a.created_at).localeCompare(String(b.created_at)),
    );
    if (/LIMIT 1/.test(sql)) rows = rows.slice(0, 1);
    return rows;
  }
}

describe("ProjectRegistry backend selection", () => {
  it("defaults to the file backend when no adapter is present", () => {
    expect(new ProjectRegistry().backend).toBe("file");
  });

  it("uses memory when explicitly requested", () => {
    expect(new ProjectRegistry({ backend: "memory" }).backend).toBe("memory");
  });

  it("selects runtime-db when a SQL adapter is supplied", () => {
    const store = new ProjectRegistry({
      runtime: { adapter: new ProjectsFakeSqlAdapter() },
    });
    expect(store.backend).toBe("runtime-db");
  });

  it("falls back to file when runtime-db is requested without an adapter", () => {
    expect(new ProjectRegistry({ backend: "runtime-db" }).backend).toBe("file");
  });
});

describe.each<[string, () => InMemoryProjectStore | RuntimeDbProjectStore]>([
  ["InMemoryProjectStore", () => new InMemoryProjectStore()],
  [
    "RuntimeDbProjectStore",
    () => new RuntimeDbProjectStore(new ProjectsFakeSqlAdapter()),
  ],
])("%s create/list/resolve", (_name, makeStore) => {
  it("creates a project with an id, trimmed name, absolute root, and timestamp", async () => {
    const store = makeStore();
    const project = await store.createProject({
      name: "  Eliza  ",
      rootDir: "/repo/eliza",
    });
    expect(project.id).toMatch(/[0-9a-f-]{36}/);
    expect(project.name).toBe("Eliza");
    expect(project.rootDir).toBe(resolvePath("/repo/eliza"));
    expect(Number.isNaN(Date.parse(project.createdAt))).toBe(false);
  });

  it("lists every created project", async () => {
    const store = makeStore();
    await store.createProject({ name: "A", rootDir: "/repo/a" });
    await store.createProject({ name: "B", rootDir: "/repo/b" });
    const names = (await store.listProjects()).map((p) => p.name).sort();
    expect(names).toEqual(["A", "B"]);
  });

  it("resolves a project by its root dir, normalizing the lookup", async () => {
    const store = makeStore();
    const created = await store.createProject({
      name: "Eliza",
      rootDir: "/repo/eliza",
    });
    // Trailing slash / dot-segment resolve to the same natural key.
    const resolved = await store.resolveProject("/repo/eliza/");
    expect(resolved?.id).toBe(created.id);
    expect((await store.resolveProject("/repo/eliza/."))?.id).toBe(created.id);
  });

  it("returns null when resolving an unregistered root", async () => {
    const store = makeStore();
    await store.createProject({ name: "Eliza", rootDir: "/repo/eliza" });
    expect(await store.resolveProject("/repo/other")).toBeNull();
  });

  it("looks a project up by id and returns null for a miss", async () => {
    const store = makeStore();
    const created = await store.createProject({
      name: "Eliza",
      rootDir: "/repo/eliza",
    });
    expect((await store.getProject(created.id))?.name).toBe("Eliza");
    expect(await store.getProject("no-such-id")).toBeNull();
  });

  it("is idempotent on rootDir: creating the same root twice yields one project", async () => {
    const store = makeStore();
    const first = await store.createProject({
      name: "Eliza",
      rootDir: "/repo/eliza",
    });
    const second = await store.createProject({
      name: "Eliza (again)",
      rootDir: "/repo/eliza/",
    });
    expect(second.id).toBe(first.id);
    expect(await store.listProjects()).toHaveLength(1);
    // First write wins the name; the binding stays stable.
    expect(second.name).toBe("Eliza");
  });
});

describe("FileProjectStore", () => {
  it("persists projects to JSON and reloads them in a fresh store", async () => {
    const file = await tempFile();
    const store = new FileProjectStore(file);
    const created = await store.createProject({
      name: "durable",
      rootDir: "/repo/durable",
    });

    const raw = JSON.parse(await readFile(file, "utf8")) as unknown[];
    expect(raw).toHaveLength(1);

    const reopened = new FileProjectStore(file);
    expect((await reopened.getProject(created.id))?.name).toBe("durable");
    expect((await reopened.resolveProject("/repo/durable"))?.id).toBe(
      created.id,
    );
  });

  it("merges a concurrent insert from another instance instead of clobbering it", async () => {
    const file = await tempFile();
    const a = new FileProjectStore(file);
    const b = new FileProjectStore(file);
    await a.listProjects();
    await b.listProjects();
    const pa = await a.createProject({ name: "from A", rootDir: "/repo/a" });
    const pb = await b.createProject({ name: "from B", rootDir: "/repo/b" });
    const reader = new FileProjectStore(file);
    const ids = (await reader.listProjects()).map((p) => p.id);
    expect(ids).toContain(pa.id);
    expect(ids).toContain(pb.id);
  });

  it("discards malformed records when loading from disk", async () => {
    const file = await tempFile();
    const seed = new FileProjectStore(file);
    const good = await seed.createProject({
      name: "good",
      rootDir: "/repo/good",
    });
    const { writeFile } = await import("node:fs/promises");
    const valid = JSON.parse(await readFile(file, "utf8")) as unknown[];
    await writeFile(
      file,
      JSON.stringify([...valid, { id: "x" }, "garbage", 7]),
      "utf8",
    );
    const reopened = new FileProjectStore(file);
    const listed = await reopened.listProjects();
    expect(listed.map((p) => p.id)).toEqual([good.id]);
  });
});

describe("RuntimeDbProjectStore durability", () => {
  it("survives a restart: a fresh store over the same adapter still resolves the project", async () => {
    const adapter = new ProjectsFakeSqlAdapter();
    const first = new RuntimeDbProjectStore(adapter);
    const created = await first.createProject({
      name: "persisted",
      rootDir: "/repo/persisted",
    });
    // Discard `first` entirely; rows live in the durable adapter.
    const second = new RuntimeDbProjectStore(adapter);
    expect((await second.getProject(created.id))?.name).toBe("persisted");
    expect((await second.resolveProject("/repo/persisted"))?.id).toBe(
      created.id,
    );
  });
});
