import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpSessionStore,
  FileSessionStore,
  InMemorySessionStore,
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
