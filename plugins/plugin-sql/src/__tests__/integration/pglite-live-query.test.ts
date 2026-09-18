/** Real local PGlite subscriptions are opt-in and independent of cloud synchronization. */
import { live } from "@electric-sql/pglite/live";
import { afterEach, describe, expect, it } from "vitest";
import { PGliteClientManager } from "../../pglite/manager";

describe("local PGlite live queries", () => {
  const managers: PGliteClientManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.close()));
  });

  it("does not load a subscription extension by default", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    managers.push(manager);
    await manager.initialize();
    expect(manager.liveQuery()).toBeNull();
  });

  it("observes insert, update and delete with an explicitly supplied local extension", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://", extensions: { live } });
    managers.push(manager);
    await manager.initialize();
    const db = manager.getConnection();
    await db.exec("CREATE TABLE live_query_contract (id integer primary key, value text not null)");
    const namespace = manager.liveQuery();
    expect(namespace).not.toBeNull();
    if (!namespace) throw new Error("Explicit live extension was not loaded");
    let rows: Array<{ id: number; value: string }> = [];
    let callbacks = 0;
    const subscription = await namespace.query<{ id: number; value: string }>(
      "SELECT id, value FROM live_query_contract ORDER BY id",
      [],
      (result) => {
        rows = result.rows;
        callbacks++;
      }
    );
    try {
      expect(subscription.initialResults.rows).toEqual([]);
      await db.query("INSERT INTO live_query_contract VALUES ($1, $2)", [1, "created"]);
      await expect.poll(() => rows).toEqual([{ id: 1, value: "created" }]);
      await db.query("UPDATE live_query_contract SET value = $1 WHERE id = $2", ["changed", 1]);
      await expect.poll(() => rows).toEqual([{ id: 1, value: "changed" }]);
      await db.query("DELETE FROM live_query_contract WHERE id = $1", [1]);
      await expect.poll(() => rows).toEqual([]);
    } finally {
      await subscription.unsubscribe();
    }
    const countAfterUnsubscribe = callbacks;
    await db.exec("INSERT INTO live_query_contract VALUES (2, 'unsubscribed')");
    // Drain local notifications after the committed write before checking disposal.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callbacks).toBe(countAfterUnsubscribe);
  });
});
