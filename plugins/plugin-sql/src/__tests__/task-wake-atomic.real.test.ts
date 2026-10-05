import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import type { DrizzleDatabase } from "../types";
import { createIsolatedTestDatabase } from "./test-helpers";

it("wake ownership and max revision are enforced in real SQL", async () => {
  const f = await createIsolatedTestDatabase("wake-boundary");
  try {
    await expect(
      f.adapter.createTask({ name: "forged", metadata: { wakeAt: 1, wakeRevision: 2 } })
    ).rejects.toThrow("atomic");
    const id = await f.adapter.createTask({
      name: "boundary",
      tags: ["queue", "repeat"],
      metadata: { updateInterval: 60000 },
    });
    const db = f.adapter.getDatabase() as DrizzleDatabase;
    await db.execute(
      sql`UPDATE tasks SET metadata=metadata || ${JSON.stringify({ wakeAt: 1000, wakeRevision: Number.MAX_SAFE_INTEGER - 1 })}::jsonb WHERE id=${id}`
    );
    await f.adapter.patchTaskMetadata(id, { wake: { requestAt: 2000 } });
    expect((await f.adapter.getTask(id))?.metadata).toMatchObject({
      wakeAt: 1000,
      wakeRevision: Number.MAX_SAFE_INTEGER,
    });
    await f.adapter.patchTaskMetadata(id, { wake: { consumeRevision: Number.MAX_SAFE_INTEGER } });
    expect((await f.adapter.getTask(id))?.metadata?.wakeAt).toBeUndefined();
    await expect(f.adapter.patchTaskMetadata(id, { wake: { requestAt: 3000 } })).rejects.toThrow();
    expect((await f.adapter.getTask(id))?.metadata?.wakeRevision).toBe(Number.MAX_SAFE_INTEGER);
  } finally {
    await f.cleanup();
  }
});
it("rejects malformed persisted numeric strings/fractions rather than coercing wake fields", async () => {
  const f = await createIsolatedTestDatabase("wake-malformed");
  try {
    const id = await f.adapter.createTask({
      name: "malformed",
      tags: ["queue", "repeat"],
      metadata: { updateInterval: 60000 },
    });
    const db = f.adapter.getDatabase() as DrizzleDatabase;
    for (const patch of [
      { wakeAt: "100", wakeRevision: 0 },
      { wakeAt: 1.5, wakeRevision: 0 },
      { wakeAt: 100, wakeRevision: "1" },
      { wakeAt: 100, wakeRevision: 1.5 },
    ]) {
      await db.execute(
        sql`UPDATE tasks SET metadata=${JSON.stringify(patch)}::jsonb WHERE id=${id}`
      );
      await expect(
        f.adapter.patchTaskMetadata(id, { wake: { consumeRevision: 0 } })
      ).rejects.toThrow();
    }
  } finally {
    await f.cleanup();
  }
});
it("wake requests remain agent scoped and do not recreate missing tasks", async () => {
  const f = await createIsolatedTestDatabase("wake-scope");
  try {
    const id = await f.adapter.createTask({
      name: "owned",
      tags: ["queue", "repeat"],
      metadata: { updateInterval: 60000 },
    });
    const foreign = "11111111-1111-4111-8111-111111111111";
    const result = await f.adapter.withAgentScope(foreign, async (scoped) =>
      scoped.patchTaskMetadata?.(id, { wake: { requestAt: 1000 } })
    );
    expect(result).toBe(false);
    expect((await f.adapter.getTask(id))?.metadata?.wakeAt).toBeUndefined();
    expect(
      await f.adapter.patchTaskMetadata("22222222-2222-4222-8222-222222222222", {
        wake: { requestAt: 1000 },
      })
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});
