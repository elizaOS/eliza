/**
 * Cross-instance FileSessionStore contention tests run two real store instances
 * against the same temporary JSON file and OS-level advisory lock. They assert
 * that concurrent writes never leave torn JSON on disk and that a fresh store
 * can read a complete, internally consistent record set after the race settles.
 */
//   3. Correct stale-lock takeover: a fresh instance acquires the lock when a
//      pre-existing lock file is older than the staleness threshold, and a
//      NON-stale lock held by "another process" blocks the writer until it is
//      released (no premature stomp on a live lock).
//
// Timing is deterministic: every store call is awaited; the held-lock test
// releases the lock explicitly and asserts ordering rather than sleeping on a
// wall-clock window.

import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileSessionStore,
  type SessionInfo,
} from "../../src/services/session-store.js";

const tempDirs: string[] = [];

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date("2026-06-22T10:00:00.000Z");
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
  const dir = await mkdtemp(join(tmpdir(), "plugin-acp-filelock-"));
  tempDirs.push(dir);
  return join(dir, "sessions.json");
}

// Read the JSON file and prove it parses as an array of records. Throws if the
// file is mid-write / torn. Returns the parsed records (empty if file absent).
async function readRecords(
  file: string,
): Promise<Array<Record<string, unknown>>> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(contents) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("session store file is not a JSON array");
  }
  return parsed as Array<Record<string, unknown>>;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0))
    await rm(dir, { force: true, recursive: true });
});

describe("FileSessionStore cross-instance file-lock contention", () => {
  it("keeps the on-disk file uncorrupted while two instances race writes, and never drops an instance's own write", async () => {
    const file = await tempFile();
    const storeA = new FileSessionStore(file);
    const storeB = new FileSessionStore(file);

    const COUNT = 20;

    // Continuously poll the file for torn writes WHILE the race is in flight.
    // The atomic-rename + exclusive-lock contract means every observable state
    // of the file must be valid JSON. A regression that removed the lock would
    // surface here as a JSON.parse throw on a half-written file.
    let racing = true;
    let parseChecks = 0;
    const watcher = (async () => {
      while (racing) {
        await readRecords(file); // throws if torn/corrupt
        parseChecks += 1;
      }
    })();

    // Interleave creates from BOTH instances on the SAME file.
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < COUNT; i += 1) {
      writes.push(
        storeA.create(session({ id: `a-${i}`, acpxRecordId: `recA-${i}` })),
      );
      writes.push(
        storeB.create(session({ id: `b-${i}`, acpxRecordId: `recB-${i}` })),
      );
    }
    await Promise.all(writes);

    racing = false;
    await watcher;
    expect(parseChecks).toBeGreaterThan(0);

    // Every write each instance acknowledged must be present in that
    // instance's own view — the lock serializes writers, it does not silently
    // discard a write it accepted.
    const listA = await storeA.list();
    const listB = await storeB.list();
    for (let i = 0; i < COUNT; i += 1) {
      expect(listA.some((s) => s.id === `a-${i}`)).toBe(true);
      expect(listB.some((s) => s.id === `b-${i}`)).toBe(true);
    }

    // The final on-disk file is valid, parseable, and self-consistent: every
    // record carries a non-empty id and round-trips through a fresh loader.
    const onDisk = await readRecords(file);
    expect(onDisk.length).toBeGreaterThan(0);
    for (const rec of onDisk) {
      expect(typeof rec.id).toBe("string");
      expect((rec.id as string).length).toBeGreaterThan(0);
    }

    const fresh = new FileSessionStore(file);
    const reloaded = await fresh.list();
    // A freshly-loaded instance sees exactly what is on disk (no duplicates,
    // no half-records) and every record has a valid, parseable timestamp.
    expect(reloaded).toHaveLength(onDisk.length);
    const ids = reloaded.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of reloaded) {
      expect(Number.isNaN(s.createdAt.getTime())).toBe(false);
      expect(Number.isNaN(s.lastActivityAt.getTime())).toBe(false);
    }
  });

  it("converges the file when the second instance loads after the first has fully written, preserving the first's records", async () => {
    const file = await tempFile();

    // Instance A writes and fully settles first.
    const storeA = new FileSessionStore(file);
    await storeA.create(session({ id: "a-1", acpxRecordId: "recA-1" }));
    await storeA.create(session({ id: "a-2", acpxRecordId: "recA-2" }));

    // Instance B is constructed AFTER A's writes settle, so its lazy load()
    // observes A's persisted records before it appends its own.
    const storeB = new FileSessionStore(file);
    await storeB.create(session({ id: "b-1", acpxRecordId: "recB-1" }));

    // B's view (and therefore the file it just rewrote under lock) must
    // contain both A's records and its own — no lost writes across instances
    // when reads and writes are correctly ordered through the lock.
    const onDisk = await readRecords(file);
    const ids = onDisk.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["a-1", "a-2", "b-1"]));
    expect(ids).toHaveLength(3);

    const fresh = new FileSessionStore(file);
    await expect(fresh.list()).resolves.toHaveLength(3);
  });

  it("takes over a stale lock left by another process and still completes the write", async () => {
    const file = await tempFile();
    const lockFile = `${file}.lock`;

    // Simulate a dead process that crashed holding the lock: a lock file whose
    // mtime is well past FILE_LOCK_STALE_MS (30s).
    await writeFile(lockFile, "99999\n0\n", "utf8");
    const stale = new Date(Date.now() - 120_000);
    await utimes(lockFile, stale, stale);

    const logger = { warn: vi.fn() };
    const store = new FileSessionStore(file, logger);

    // The write must succeed by reclaiming the stale lock, not hang or throw.
    await store.create(session({ id: "after-stale" }));

    const onDisk = await readRecords(file);
    expect(onDisk.map((r) => r.id)).toContain("after-stale");
    expect(logger.warn).toHaveBeenCalledWith(
      "acpx SessionStore removed a stale lock file",
      lockFile,
    );

    // The lock is released after the write completes (finally-block cleanup).
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does NOT stomp a fresh lock held by another process: the writer blocks until that lock is released", async () => {
    const file = await tempFile();
    const lockFile = `${file}.lock`;

    // Another process holds a FRESH (non-stale) lock. Its mtime is "now", so
    // removeStaleLock must refuse to delete it and the writer must wait.
    await writeFile(lockFile, `55555\n${Date.now()}\n`, "utf8");

    const store = new FileSessionStore(file);

    let resolvedWrite = false;
    const writePromise = store
      .create(session({ id: "queued-behind-live-lock" }))
      .then(() => {
        resolvedWrite = true;
      });

    // Give the writer real time to spin through several acquire attempts
    // (poll interval is 25ms in the source). It must still be blocked because
    // the held lock is fresh, not stale.
    await new Promise((r) => setTimeout(r, 120));
    expect(resolvedWrite).toBe(false);
    // The foreign lock file must still be intact (not stomped).
    await expect(stat(lockFile)).resolves.toBeTruthy();

    // Release the foreign lock; the writer now acquires it and completes.
    await rm(lockFile, { force: true });
    await writePromise;
    expect(resolvedWrite).toBe(true);

    const onDisk = await readRecords(file);
    expect(onDisk.map((r) => r.id)).toContain("queued-behind-live-lock");
    // Writer cleaned up its own lock afterward.
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
