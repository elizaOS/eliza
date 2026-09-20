/** Exercises real PGlite subscriptions through insert, update, delete and unsubscribe flows. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { live as liveExtension } from "@electric-sql/pglite/live";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { PGliteClientManager } from "../../pglite/manager";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";

it("does not load a subscription extension by default", async () => {
  const manager = new PGliteClientManager({ dataDir: "memory://" });
  try {
    await manager.initialize();
    expect(manager.liveQuery()).toBeNull();
  } finally {
    await manager.close();
  }
});

describe("PGlite live query flows", () => {
  let dir: string;
  let manager: PGliteClientManager;
  let db: DrizzleDatabase;
  let live: NonNullable<ReturnType<PGliteClientManager["liveQuery"]>>;
  let agentId: string;
  let roomId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-live-query-"));
    agentId = crypto.randomUUID();
    roomId = crypto.randomUUID();
    manager = new PGliteClientManager({
      dataDir: dir,
      agentId,
      extensions: { live: liveExtension },
    });
    await manager.initialize();
    db = drizzle(manager.getConnection()) as unknown as DrizzleDatabase;
    const migrations = new DatabaseMigrationService();
    await migrations.initializeWithDatabase(db);
    migrations.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrations.runAllPluginMigrations();
    const namespace = manager.liveQuery();
    if (!namespace) throw new Error("PGlite live extension is required");
    live = namespace;
    await db.execute(sql`
      INSERT INTO agents (id, name, created_at, updated_at)
      VALUES (${agentId}, 'live-query-test', now(), now())
    `);
    await db.execute(sql`
      INSERT INTO rooms (id, agent_id, name, source, type, created_at)
      VALUES (${roomId}, ${agentId}, 'seed', 'test', 'GROUP', now())
    `);
  }, 60_000);

  afterEach(async () => {
    try {
      await manager.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes exact memory counts across inserts within the latency budget", async () => {
    let count = -1;
    let started = 0;
    let firstInsertLatency = Number.POSITIVE_INFINITY;
    await live.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM memories WHERE agent_id = $1",
      [agentId],
      (result) => {
        count = Number(result.rows[0].count);
        if (count === 1) firstInsertLatency = performance.now() - started;
      }
    );
    await expect.poll(() => count).toBe(0);
    for (let index = 1; index <= 3; index += 1) {
      if (index === 1) started = performance.now();
      await db.execute(sql`
        INSERT INTO memories (id, type, agent_id, room_id, content, created_at)
        VALUES (${crypto.randomUUID()}, 'test', ${agentId}, ${roomId}, '{"text":"reactive"}'::jsonb, now())
      `);
      await expect.poll(() => count).toBe(index);
    }
    expect(firstInsertLatency).toBeLessThan(100);
  });

  it("publishes room mutations and stops both subscriptions after unsubscribe", async () => {
    let names: string[] = [];
    let count = -1;
    let started = 0;
    let insertLatency = Number.POSITIVE_INFINITY;
    const rows = await live.query<{ name: string }>(
      "SELECT name FROM rooms WHERE agent_id = $1 ORDER BY name",
      [agentId],
      (result) => {
        names = result.rows.map((row) => row.name);
      }
    );
    const counts = await live.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM rooms WHERE agent_id = $1",
      [agentId],
      (result) => {
        count = Number(result.rows[0].count);
        if (count === 2) insertLatency = performance.now() - started;
      }
    );
    await expect.poll(() => names).toEqual(["seed"]);
    await expect.poll(() => count).toBe(1);

    const addedRoom = crypto.randomUUID();
    started = performance.now();
    await db.execute(sql`
      INSERT INTO rooms (id, agent_id, name, source, type, created_at)
      VALUES (${addedRoom}, ${agentId}, 'new', 'test', 'GROUP', now())
    `);
    await expect.poll(() => names).toEqual(["new", "seed"]);
    await expect.poll(() => count).toBe(2);
    expect(insertLatency).toBeLessThan(100);

    await db.execute(sql`UPDATE rooms SET name = 'updated' WHERE id = ${addedRoom}`);
    await expect.poll(() => names).toEqual(["seed", "updated"]);
    await db.execute(sql`DELETE FROM rooms WHERE id = ${roomId}`);
    await expect.poll(() => names).toEqual(["updated"]);
    await expect.poll(() => count).toBe(1);

    await rows.unsubscribe();
    await counts.unsubscribe();
    await db.execute(sql`
      INSERT INTO rooms (id, agent_id, name, source, type, created_at)
      VALUES (${crypto.randomUUID()}, ${agentId}, 'ignored', 'test', 'GROUP', now())
    `);
    // Preserve a bounded observation period for callbacks that must not occur.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(names).toEqual(["updated"]);
    expect(count).toBe(1);
  });
});
