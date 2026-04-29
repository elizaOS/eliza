import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemRuntimeOperationRepository } from "./repository.js";
import type { RuntimeOperation } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let tmpStateDir: string;

beforeEach(() => {
  tmpStateDir = mkdtempSync(join(tmpdir(), "runtime-ops-test-"));
});

afterEach(() => {
  rmSync(tmpStateDir, { recursive: true, force: true });
});

function makeOp(
  partial: Partial<RuntimeOperation> & { id: string },
): RuntimeOperation {
  const startedAt = partial.startedAt ?? Date.now();
  return {
    id: partial.id,
    kind: partial.kind ?? "restart",
    intent: partial.intent ?? { kind: "restart", reason: "test" },
    tier: partial.tier ?? "cold",
    status: partial.status ?? "succeeded",
    phases: partial.phases ?? [],
    startedAt,
    finishedAt: partial.finishedAt ?? startedAt + 1,
    ...(partial.idempotencyKey
      ? { idempotencyKey: partial.idempotencyKey }
      : {}),
    ...(partial.error ? { error: partial.error } : {}),
  };
}

function listFiles(stateDir: string): string[] {
  const dir = join(stateDir, "runtime-operations");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("FilesystemRuntimeOperationRepository — pruneTerminal", () => {
  test("drops a terminal op older than retention", async () => {
    const repo = new FilesystemRuntimeOperationRepository(tmpStateDir, {
      retentionMs: 7 * DAY_MS,
      maxRecords: 1000,
    });
    const now = Date.now();
    // Seed both as fresh so the post-create opportunistic prune doesn't
    // touch them; force staleness later by passing a future "now".
    await repo.create(
      makeOp({
        id: "stale",
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
      }),
    );
    await repo.create(
      makeOp({
        id: "fresh",
        status: "succeeded",
        startedAt: now + 10 * DAY_MS,
        finishedAt: now + 10 * DAY_MS,
      }),
    );

    const removed = await repo.pruneTerminal(now + 15 * DAY_MS);
    expect(removed).toBe(1);
    expect(await repo.get("stale")).toBeNull();
    expect(await repo.get("fresh")).not.toBeNull();
    expect(listFiles(tmpStateDir)).toEqual(["fresh.json"]);
  });

  test("preserves a terminal op inside retention", async () => {
    const repo = new FilesystemRuntimeOperationRepository(tmpStateDir, {
      retentionMs: 7 * DAY_MS,
      maxRecords: 1000,
    });
    const now = Date.now();
    const op = makeOp({
      id: "kept",
      status: "succeeded",
      startedAt: now - 1 * DAY_MS,
      finishedAt: now - 1 * DAY_MS,
    });
    await repo.create(op);

    const removed = await repo.pruneTerminal(now);
    expect(removed).toBe(0);
    expect(await repo.get("kept")).not.toBeNull();
  });

  test("never reaps a pending or running op even when older than retention", async () => {
    const repo = new FilesystemRuntimeOperationRepository(tmpStateDir, {
      retentionMs: 7 * DAY_MS,
      maxRecords: 0, // would force-drop everything terminal
    });
    const now = Date.now();
    const pending = makeOp({
      id: "pending",
      status: "pending",
      startedAt: now - 1 * HOUR_MS, // young enough to dodge the 24h abandoned reaper
      finishedAt: undefined,
    });
    const running = makeOp({
      id: "running",
      status: "running",
      startedAt: now - 1 * HOUR_MS,
      finishedAt: undefined,
    });
    await repo.create(pending);
    await repo.create(running);

    const removed = await repo.pruneTerminal(now);
    expect(removed).toBe(0);
    expect(await repo.get("pending")).not.toBeNull();
    expect(await repo.get("running")).not.toBeNull();
  });

  test("enforces the max-records cap, keeping the newest", async () => {
    const repo = new FilesystemRuntimeOperationRepository(tmpStateDir, {
      retentionMs: 365 * DAY_MS, // age cap won't kick in
      maxRecords: 3,
    });
    const base = Date.now() - 10 * 1000;
    for (let i = 0; i < 5; i++) {
      await repo.create(
        makeOp({
          id: `op-${i}`,
          status: "succeeded",
          startedAt: base + i * 100,
          finishedAt: base + i * 100,
        }),
      );
    }

    // Final create() runs an opportunistic prune; allow it to settle.
    await repo.pruneTerminal();

    const remaining = await repo.list();
    expect(remaining.map((op) => op.id).sort()).toEqual([
      "op-2",
      "op-3",
      "op-4",
    ]);
    expect(listFiles(tmpStateDir).sort()).toEqual([
      "op-2.json",
      "op-3.json",
      "op-4.json",
    ]);
  });

  test("dropping a terminal op also frees its idempotency-key slot", async () => {
    const repo = new FilesystemRuntimeOperationRepository(tmpStateDir, {
      retentionMs: 7 * DAY_MS,
      maxRecords: 1000,
    });
    const now = Date.now();
    // Seed as fresh so the opportunistic prune doesn't touch it.
    await repo.create(
      makeOp({
        id: "stale-idem",
        status: "succeeded",
        idempotencyKey: "key-1",
        startedAt: now,
        finishedAt: now,
      }),
    );
    expect(await repo.findByIdempotencyKey("key-1")).not.toBeNull();

    // Now force the op to look stale by passing a future "now".
    await repo.pruneTerminal(now + 30 * DAY_MS);
    expect(await repo.findByIdempotencyKey("key-1")).toBeNull();

    // The slot is now free for a new op with the same key.
    await repo.create(
      makeOp({
        id: "fresh-idem",
        status: "succeeded",
        idempotencyKey: "key-1",
        startedAt: now + 30 * DAY_MS + 1,
        finishedAt: now + 30 * DAY_MS + 1,
      }),
    );
    const found = await repo.findByIdempotencyKey("key-1");
    expect(found?.id).toBe("fresh-idem");
  });

  test("hydration prunes stale terminal ops on first access", async () => {
    const now = Date.now();

    // Seed disk via a first repo instance.
    const seeder = new FilesystemRuntimeOperationRepository(tmpStateDir, {
      retentionMs: 7 * DAY_MS,
      maxRecords: 1000,
    });
    await seeder.create(
      makeOp({
        id: "ancient",
        status: "succeeded",
        startedAt: now - 30 * DAY_MS,
        finishedAt: now - 30 * DAY_MS,
      }),
    );
    await seeder.create(
      makeOp({
        id: "recent",
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
      }),
    );

    // The seed create() calls fired their own opportunistic prunes which
    // would have removed `ancient`. To exercise the hydrate-time prune
    // independently, drop the in-memory state and re-instantiate while
    // re-creating the disk file directly.
    const filesAfterSeed = listFiles(tmpStateDir);
    expect(filesAfterSeed).toContain("recent.json");

    // Restore `ancient.json` by writing it back through a fresh repo with a
    // permissive cap so the post-create prune does not touch it.
    const permissiveRepo = new FilesystemRuntimeOperationRepository(
      tmpStateDir,
      {
        retentionMs: 365 * DAY_MS, // disable age-based pruning
        maxRecords: 1000,
      },
    );
    await permissiveRepo.create(
      makeOp({
        id: "ancient",
        status: "succeeded",
        startedAt: now - 30 * DAY_MS,
        finishedAt: now - 30 * DAY_MS,
      }),
    );
    expect(listFiles(tmpStateDir).sort()).toEqual([
      "ancient.json",
      "recent.json",
    ]);

    // Now construct a new strict repo. Its hydrate() should prune `ancient`.
    const strict = new FilesystemRuntimeOperationRepository(tmpStateDir, {
      retentionMs: 7 * DAY_MS,
      maxRecords: 1000,
    });
    expect(await strict.get("ancient")).toBeNull();
    expect(await strict.get("recent")).not.toBeNull();
    expect(listFiles(tmpStateDir)).toEqual(["recent.json"]);
  });
});
