/**
 * Exercises adapter-scoped commit, rollback, savepoints, entity context, and
 * identity isolation against real PGlite and optional local PostgreSQL.
 * Set SQL_TRANSACTION_TEST_POSTGRES_URL to a disposable test database to run both.
 */
import { randomUUID } from "node:crypto";
import type { UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BaseDrizzleAdapter } from "../base";
import { DatabaseMigrationService } from "../migration-service";
import { PgDatabaseAdapter } from "../pg/adapter";
import { PostgresConnectionManager } from "../pg/manager";
import { PgliteDatabaseAdapter } from "../pglite/adapter";
import { PGliteClientManager } from "../pglite/manager";
import * as schema from "../schema";

const postgresUrl = process.env.SQL_TRANSACTION_TEST_POSTGRES_URL;
const backends = postgresUrl ? ["pglite", "postgres"] : ["pglite"];

for (const backend of backends) {
  describe(`${backend} adapter transactions`, () => {
    let adapter: BaseDrizzleAdapter;
    let pgliteManager: PGliteClientManager | undefined;
    const agentId = randomUUID() as UUID;

    beforeAll(async () => {
      if (backend === "postgres") {
        if (!postgresUrl) throw new Error("PostgreSQL test URL unavailable");
        adapter = new PgDatabaseAdapter(agentId, new PostgresConnectionManager(postgresUrl));
      } else {
        pgliteManager = new PGliteClientManager({ dataDir: "memory://" });
        adapter = new PgliteDatabaseAdapter(agentId, pgliteManager);
      }
      await adapter.init();
      const migrations = new DatabaseMigrationService();
      await migrations.initializeWithDatabase(adapter.db);
      migrations.discoverAndRegisterPluginSchemas([
        { name: "@elizaos/plugin-sql", description: "SQL adapter", schema },
      ]);
      await migrations.runAllPluginMigrations();
      await adapter.createAgent({ id: agentId, name: "Transaction contract" });
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await adapter.close();
    });

    it("commits writes from multiple adapter methods and returns the callback value", async () => {
      const id = randomUUID() as UUID;
      const receipt = await adapter.transaction(async (tx) => {
        await tx.createEntities([{ id, agentId, names: ["Committed contact"] }]);
        await tx.setCache("committed", { id });
        expect((await tx.getEntitiesByIds([id]))?.[0]?.names).toEqual(["Committed contact"]);
        return await tx.getCache("committed");
      });
      expect(receipt).toEqual({ id });
      expect(await adapter.getCache("committed")).toEqual({ id });
      expect((await adapter.getEntitiesByIds([id]))?.[0]?.names).toEqual(["Committed contact"]);
    });

    it("rolls back all methods when a real SQL statement fails", async () => {
      const id = randomUUID() as UUID;
      await expect(
        adapter.transaction(async (tx) => {
          await tx.createEntities([{ id, agentId, names: ["Rolled back"] }]);
          await tx.setCache("rolled-back", { id });
          await tx.db.execute(sql`SELECT 1 / 0`);
        })
      ).rejects.toThrow();
      expect(await adapter.getEntitiesByIds([id])).toEqual([]);
      expect(await adapter.getCache("rolled-back")).toBeUndefined();
      await expect(adapter.setCache("after-rollback", true)).resolves.toBe(true);
    });

    it("isolates a caught child failure in a savepoint while committing its parent", async () => {
      await adapter.transaction(async (tx) => {
        await tx.setCache("parent-kept", true);
        await expect(
          tx.transaction(async (child) => {
            await child.setCache("child-discarded", true);
            await child.db.execute(sql`SELECT 1 / 0`);
          })
        ).rejects.toThrow();
        expect(await tx.getCache("child-discarded")).toBeUndefined();
        await tx.setCache("parent-continued", true);
      });
      expect(await adapter.getCache("parent-kept")).toBe(true);
      expect(await adapter.getCache("parent-continued")).toBe(true);
      expect(await adapter.getCache("child-discarded")).toBeUndefined();
    });

    it("rolls back a successful child when its parent fails", async () => {
      await expect(
        adapter.transaction(async (tx) => {
          await tx.transaction(async (child) => {
            await child.setCache("child-of-failed-parent", true);
          });
          throw new Error("Parent failed");
        })
      ).rejects.toThrow("Parent failed");
      expect(await adapter.getCache("child-of-failed-parent")).toBeUndefined();
    });

    it("inherits nested entity context and rejects switching identities", async () => {
      const entityContext = randomUUID() as UUID;
      await adapter.transaction(
        async (tx) => {
          await tx.transaction(async (child) => {
            await child.transaction(
              async (grandchild) => {
                await grandchild.setCache("same-entity", true);
              },
              { entityContext }
            );
          });
          await expect(
            tx.transaction(
              async (other) => {
                await other.setCache("wrong-entity", true);
              },
              { entityContext: randomUUID() as UUID }
            )
          ).rejects.toMatchObject({
            code: "TRANSACTION_ENTITY_CONTEXT_MISMATCH",
          });
        },
        { entityContext }
      );
      expect(await adapter.getCache("same-entity")).toBe(true);
      expect(await adapter.getCache("wrong-entity")).toBeUndefined();
    });

    if (backend === "postgres") {
      it("keeps PostgreSQL entity context through nested savepoints", async () => {
        const entityContext = randomUUID() as UUID;
        const priorIsolation = process.env.ENABLE_DATA_ISOLATION;
        process.env.ENABLE_DATA_ISOLATION = "true";
        try {
          await adapter.transaction(
            async (tx) => {
              await tx.transaction(async (child) => {
                const result = await child.db.execute(
                  sql`SELECT current_setting('app.entity_id', true) AS entity_id`
                );
                expect(result.rows[0]).toEqual({ entity_id: entityContext });
              });
              const result = await tx.db.execute(
                sql`SELECT current_setting('app.entity_id', true) AS entity_id`
              );
              expect(result.rows[0]).toEqual({ entity_id: entityContext });
            },
            { entityContext }
          );
          const result = await adapter.db.execute(
            sql`SELECT current_setting('app.entity_id', true) AS entity_id`
          );
          expect(result.rows[0]?.entity_id).not.toBe(entityContext);
          await adapter.transaction(async (system) => {
            for (const scopedEntity of [entityContext, randomUUID() as UUID]) {
              await system.transaction(
                async (child) => {
                  const scoped = await child.db.execute(
                    sql`SELECT current_setting('app.entity_id', true) AS entity_id`
                  );
                  expect(scoped.rows[0]).toEqual({ entity_id: scopedEntity });
                },
                { entityContext: scopedEntity }
              );
              const restored = await system.db.execute(
                sql`SELECT current_setting('app.entity_id', true) AS entity_id`
              );
              expect(restored.rows[0]?.entity_id).not.toBe(scopedEntity);
            }
          });
        } finally {
          if (priorIsolation === undefined) delete process.env.ENABLE_DATA_ISOLATION;
          else process.env.ENABLE_DATA_ISOLATION = priorIsolation;
        }
      });
    }
  });
}
