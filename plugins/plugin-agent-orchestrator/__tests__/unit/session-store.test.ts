import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpSessionStore,
  FileSessionStore,
  InMemorySessionStore,
  RuntimeDbSessionStore,
} from "../../src/services/session-store.js";
import type { SessionInfo, SessionStore } from "../../src/services/types.js";

const tempDirs: string[] = [];

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date("2026-05-03T10:00:00.000Z");
  return {
    id: "session-1",
    name: "main",
    agentType: "codex",
    workdir: "/repo",
    status: "running",
    acpxRecordId: "record-1",
    acpxSessionId: "acpx-1",
    agentSessionId: "agent-1",
    pid: 123,
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { purpose: "test" },
    ...overrides,
  };
}

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plugin-acp-session-store-"));
  tempDirs.push(dir);
  return join(dir, "sessions.json");
}

async function expectAllInterfaceMethods(store: SessionStore): Promise<void> {
  const original = session();
  await store.create(original);
  await store.create(
    session({ id: "session-2", name: undefined, acpxRecordId: "record-2" }),
  );

  await expect(store.get("session-1")).resolves.toMatchObject({
    id: "session-1",
    name: "main",
  });
  await expect(store.get("missing")).resolves.toBeNull();
  await expect(store.getByAcpxRecordId("record-1")).resolves.toMatchObject({
    id: "session-1",
  });
  await expect(store.getByAcpxRecordId("missing")).resolves.toBeNull();
  await expect(
    store.findByScope({ workdir: "/repo", agentType: "codex", name: "main" }),
  ).resolves.toMatchObject({
    id: "session-1",
  });
  await expect(
    store.findByScope({ workdir: "/repo", agentType: "codex" }),
  ).resolves.toMatchObject({ id: "session-2" });
  await expect(store.list()).resolves.toHaveLength(2);
  await expect(store.list({ status: "running" })).resolves.toHaveLength(2);

  await store.update("session-1", {
    status: "blocked",
    metadata: { updated: true },
  });
  const updated = await store.get("session-1");
  expect(updated).toMatchObject({
    status: "blocked",
    metadata: { updated: true },
  });
  expect(updated?.lastActivityAt.getTime()).toBeGreaterThan(
    original.lastActivityAt.getTime(),
  );

  const explicitActivity = new Date("2026-05-03T11:00:00.000Z");
  await store.update("session-1", { lastActivityAt: explicitActivity });
  await expect(store.get("session-1")).resolves.toMatchObject({
    lastActivityAt: explicitActivity,
  });

  await store.updateStatus("session-1", "errored", "boom");
  await expect(store.get("session-1")).resolves.toMatchObject({
    status: "errored",
    lastError: "boom",
  });

  await store.delete("session-2");
  await expect(store.get("session-2")).resolves.toBeNull();

  const oldClosed = new Date(Date.now() - 10_000);
  await store.update("session-1", {
    status: "stopped",
    lastActivityAt: oldClosed,
  });
  await expect(store.sweepStale(1_000)).resolves.toEqual(["session-1"]);
  await expect(store.list()).resolves.toEqual([]);
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0))
    await rm(dir, { force: true, recursive: true });
});

describe("InMemorySessionStore", () => {
  it("implements all SessionStore methods", async () => {
    await expectAllInterfaceMethods(new InMemorySessionStore());
  });

  it("serializes concurrent writes", async () => {
    const store = new InMemorySessionStore();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.create(session({ id: `s-${index}` })),
      ),
    );
    await expect(store.list()).resolves.toHaveLength(25);
  });

  it("does not downgrade a terminal status under concurrent updates (#11028)", async () => {
    const store = new InMemorySessionStore();
    await store.create(session({ id: "race", status: "running" }));
    // A terminal update racing several non-terminal ones. With the guard checked
    // outside the write queue, all four read "running", all pass the guard, and
    // the last-enqueued (a non-terminal) would win — downgrading the session
    // back to a live status. The guard now lives inside the queue.
    await Promise.all([
      store.updateStatus("race", "busy"),
      store.updateStatus("race", "stopped"),
      store.updateStatus("race", "running"),
      store.updateStatus("race", "tool_running"),
    ]);
    expect((await store.get("race"))?.status).toBe("stopped");
  });

  it("ignores a terminal → non-terminal downgrade", async () => {
    const store = new InMemorySessionStore();
    await store.create(session({ id: "term", status: "running" }));
    await store.updateStatus("term", "stopped");
    await store.updateStatus("term", "running");
    expect((await store.get("term"))?.status).toBe("stopped");
  });

  it("sweeps only old stopped and errored sessions", async () => {
    const store = new InMemorySessionStore();
    const old = new Date(Date.now() - 10_000);
    const recent = new Date();
    await store.create(
      session({ id: "old-stopped", status: "stopped", lastActivityAt: old }),
    );
    await store.create(
      session({ id: "old-errored", status: "errored", lastActivityAt: old }),
    );
    await store.create(
      session({ id: "old-running", status: "running", lastActivityAt: old }),
    );
    await store.create(
      session({ id: "new-stopped", status: "stopped", lastActivityAt: recent }),
    );

    await expect(store.sweepStale(1_000)).resolves.toEqual([
      "old-stopped",
      "old-errored",
    ]);
    await expect(store.list()).resolves.toHaveLength(2);
  });

  it("handles findByScope named, unnamed, and missing cases", async () => {
    const store = new InMemorySessionStore();
    await store.create(session({ id: "named", name: "alpha" }));
    await store.create(session({ id: "unnamed", name: undefined }));

    await expect(
      store.findByScope({
        workdir: "/repo",
        agentType: "codex",
        name: "alpha",
      }),
    ).resolves.toMatchObject({
      id: "named",
    });
    await expect(
      store.findByScope({ workdir: "/repo", agentType: "codex" }),
    ).resolves.toMatchObject({ id: "unnamed" });
    await expect(
      store.findByScope({ workdir: "/repo", agentType: "codex", name: "beta" }),
    ).resolves.toBeNull();
  });

  it("updates lastActivityAt on status transitions", async () => {
    vi.useFakeTimers();
    const store = new InMemorySessionStore();
    await store.create(
      session({ lastActivityAt: new Date("2026-05-03T10:00:00.000Z") }),
    );
    vi.setSystemTime(new Date("2026-05-03T10:05:00.000Z"));

    await store.updateStatus("session-1", "blocked");
    const blocked = await store.get("session-1");
    expect(blocked?.lastActivityAt.toISOString()).toBe(
      "2026-05-03T10:05:00.000Z",
    );
    expect(blocked?.lastError).toBeUndefined();

    vi.setSystemTime(new Date("2026-05-03T10:06:00.000Z"));
    await store.updateStatus("session-1", "errored", "failed");
    const errored = await store.get("session-1");
    expect(errored?.lastActivityAt.toISOString()).toBe(
      "2026-05-03T10:06:00.000Z",
    );
    expect(errored?.lastError).toBe("failed");
  });
});

describe("FileSessionStore", () => {
  it("implements all SessionStore methods", async () => {
    await expectAllInterfaceMethods(new FileSessionStore(await tempFile()));
  });

  it("persists via atomic JSON writes", async () => {
    const file = await tempFile();
    const store = new FileSessionStore(file);
    await store.create(session());

    const reloaded = new FileSessionStore(file);
    await expect(reloaded.get("session-1")).resolves.toMatchObject({
      id: "session-1",
      createdAt: session().createdAt,
    });
    await expect(readFile(file, "utf8")).resolves.toContain("session-1");
  });

  it("serializes concurrent writes", async () => {
    const store = new FileSessionStore(await tempFile());
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.create(session({ id: `file-${index}` })),
      ),
    );
    await expect(store.list()).resolves.toHaveLength(20);
  });

  it("recovers from a stale lock file", async () => {
    const file = await tempFile();
    const lockFile = `${file}.lock`;
    await writeFile(lockFile, "", "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockFile, old, old);

    const logger = { warn: vi.fn() };
    const store = new FileSessionStore(file, logger);
    await store.create(session());

    await expect(readFile(file, "utf8")).resolves.toContain("session-1");
    expect(logger.warn).toHaveBeenCalledWith(
      "acpx SessionStore removed a stale lock file",
      lockFile,
    );
  });

  it("recovers from corrupt JSON with an empty store and warning", async () => {
    const file = await tempFile();
    await writeFile(file, "not json", "utf8");
    const logger = { warn: vi.fn() };
    const store = new FileSessionStore(file, logger);

    await expect(store.list()).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("AcpSessionStore", () => {
  it("selects runtime DB when a SQL adapter is available", () => {
    const adapter = { query: vi.fn() };
    const store = new AcpSessionStore({
      runtime: { databaseAdapter: adapter },
    });
    expect(store.backend).toBe("runtime-db");
  });

  it("reads the modern `runtime.adapter` property, not just the legacy `runtime.databaseAdapter`", () => {
    // packages/core/src/runtime.ts exposes `public adapter!: IDatabaseAdapter`,
    // so this is how a real eliza runtime feeds a database into the store.
    const store = new AcpSessionStore({
      runtime: { adapter: { query: vi.fn() } },
    });
    expect(store.backend).toBe("runtime-db");
  });

  it("recognizes an eliza `BaseDrizzleAdapter` shape (adapter.db.execute)", () => {
    // The real @elizaos/plugin-sql adapter exposes SQL through `adapter.db`
    // (a drizzle instance) rather than flat top-level methods. The store must
    // recognize this shape too, or every real container silently falls to the
    // file backend and loses sessions on container recreation.
    const fakeDrizzleAdapter = { db: { execute: () => Promise.resolve([]) } };
    const store = new AcpSessionStore({
      runtime: { adapter: fakeDrizzleAdapter },
    });
    expect(store.backend).toBe("runtime-db");
  });

  it("lets an explicit memory backend win over an available adapter", () => {
    const store = new AcpSessionStore({
      backend: "memory",
      runtime: { adapter: { query: vi.fn() } },
    });
    expect(store.backend).toBe("memory");
  });

  it("selects explicit in-memory backend and warns", () => {
    const logger = { warn: vi.fn() };
    const store = new AcpSessionStore({
      backend: "memory",
      runtime: { logger },
    });
    expect(store.backend).toBe("memory");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

/** Raw flat-methods adapter over a REAL pglite database. Postgres speaks
 * `$n` placeholders, so this hand-rolled binding rewrites the store's `?`
 * placeholders the way any real raw postgres binding would. */
function rawPgliteAdapter(client: PGlite) {
  const rewrite = (sql: string) => {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  };
  return {
    execute: async (sql: string, params: unknown[] = []) =>
      client.query(rewrite(sql), params),
    all: async (sql: string, params: unknown[] = []) =>
      (await client.query(rewrite(sql), params)).rows,
  };
}

describe("RuntimeDbSessionStore (real pglite)", () => {
  const clients: PGlite[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
  });

  async function elizaShapedAdapter() {
    const client = new PGlite();
    clients.push(client);
    // Same shape as @elizaos/plugin-sql's BaseDrizzleAdapter: the executor
    // lives at `adapter.db` (a real drizzle instance over real pglite).
    return { db: drizzle(client) };
  }

  it("round-trips the full SessionStore surface against real pglite via the eliza drizzle shape", {
    timeout: 60_000,
  }, async () => {
    const adapter = await elizaShapedAdapter();
    await expectAllInterfaceMethods(new RuntimeDbSessionStore(adapter));
  });

  it("upserting the same id twice updates in place (portable ON CONFLICT path)", {
    timeout: 60_000,
  }, async () => {
    const adapter = await elizaShapedAdapter();
    const store = new RuntimeDbSessionStore(adapter);

    await store.create(session({ status: "starting" }));
    // Second create with the same id must take the DO UPDATE branch —
    // the old SQLite-only `INSERT OR REPLACE` is a syntax error on
    // postgres/pglite, and a plain INSERT would violate the primary key.
    await store.create(
      session({ status: "running", metadata: { attempt: 2 } }),
    );

    await expect(store.list()).resolves.toHaveLength(1);
    await expect(store.get("session-1")).resolves.toMatchObject({
      status: "running",
      metadata: { attempt: 2 },
    });
  });

  it("survives a restart: a fresh store over the same database still sees every session", {
    timeout: 60_000,
  }, async () => {
    // Regression for the live symptom behind #10991: with the file backend
    // the JSON store lives on the container's ephemeral overlay filesystem,
    // so recreation wipes it. The SQL backend must not depend on any
    // in-memory state: a brand-new store instance over the same durable
    // rows still resolves sessions by id, scope, and acpx record id.
    const adapter = await elizaShapedAdapter();
    const store1 = new RuntimeDbSessionStore(adapter);
    await store1.create(session());
    await store1.create(
      session({ id: "session-2", name: "review", acpxRecordId: "record-2" }),
    );

    const store2 = new RuntimeDbSessionStore(adapter);
    await expect(store2.list()).resolves.toHaveLength(2);
    await expect(store2.get("session-1")).resolves.toMatchObject({
      id: "session-1",
      name: "main",
      metadata: { purpose: "test" },
    });
    await expect(
      store2.findByScope({
        workdir: "/repo",
        agentType: "codex",
        name: "review",
      }),
    ).resolves.toMatchObject({ id: "session-2" });
    await expect(store2.getByAcpxRecordId("record-2")).resolves.toMatchObject({
      id: "session-2",
    });
  });

  it("works against real pglite through a raw flat-methods adapter", {
    timeout: 60_000,
  }, async () => {
    // Proves the upsert SQL itself is portable: pglite rejects the
    // SQLite-only `INSERT OR REPLACE` at parse time, so this create/update
    // round-trip only passes with `ON CONFLICT (id) DO UPDATE`.
    const client = new PGlite();
    clients.push(client);
    const store = new RuntimeDbSessionStore(rawPgliteAdapter(client));

    await store.create(session());
    await store.update("session-1", { status: "blocked" });
    await expect(store.get("session-1")).resolves.toMatchObject({
      id: "session-1",
      status: "blocked",
    });
    await store.delete("session-1");
    await expect(store.get("session-1")).resolves.toBeNull();
  });

  it("never emits SQLite-only INSERT OR REPLACE", {
    timeout: 60_000,
  }, async () => {
    const client = new PGlite();
    clients.push(client);
    const inner = rawPgliteAdapter(client);
    const seenSql: string[] = [];
    const capturing = {
      execute: (sql: string, params?: unknown[]) => {
        seenSql.push(sql);
        return inner.execute(sql, params ?? []);
      },
      all: (sql: string, params?: unknown[]) => inner.all(sql, params ?? []),
    };
    const store = new RuntimeDbSessionStore(capturing);
    await store.create(session());

    const inserts = seenSql.filter((sql) => /INSERT\s+INTO/i.test(sql));
    expect(inserts.length).toBeGreaterThan(0);
    for (const sql of inserts) {
      expect(sql).toMatch(/ON CONFLICT/i);
      expect(sql).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
    }
  });
});
