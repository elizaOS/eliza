/**
 * Exercises adapter-scoped commit, rollback, savepoints, entity context, and
 * write-back publication against real PGlite and optional local PostgreSQL.
 * Set SQL_TRANSACTION_TEST_POSTGRES_URL to a disposable test database to run both.
 */
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ChannelType, type UUID } from "@elizaos/core";
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
        pgliteManager = new PGliteClientManager(new PGlite());
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
    if (backend === "pglite") {
      it("uses the transaction connection for participant, relationship and deleted-memory write-back IDs", async () => {
        if (!pgliteManager) throw new Error("PGlite manager unavailable");
        const notify = vi.spyOn(pgliteManager, "notifyWrite");
        const sourceId = randomUUID() as UUID;
        const targetId = randomUUID() as UUID;
        const roomId = randomUUID() as UUID;
        const memoryId = randomUUID() as UUID;
        await adapter.transaction(async (tx) => {
          await tx.createEntities([
            { id: sourceId, agentId, names: ["Source"] },
            { id: targetId, agentId, names: ["Target"] },
          ]);
          await tx.createRooms([
            {
              id: roomId,
              agentId,
              name: "Transaction room",
              source: "audit",
              type: ChannelType.GROUP,
            },
          ]);
          await tx.addParticipant(sourceId, roomId);
          await tx.createRelationship({ sourceEntityId: sourceId, targetEntityId: targetId });
          await tx.createMemory(
            {
              id: memoryId,
              agentId,
              entityId: sourceId,
              roomId,
              content: { text: "Temporary transaction message" },
            },
            "messages"
          );
          await tx.deleteAllMemories([roomId], "messages");
          expect(notify).not.toHaveBeenCalled();
        });
        expect(await adapter.getMemoryById(memoryId)).toBeNull();
        const participants = await adapter.db.execute(
          sql`SELECT id FROM participants WHERE room_id = ${roomId}`
        );
        const relationships = await adapter.db.execute(
          sql`SELECT id FROM relationships WHERE source_entity_id = ${sourceId}`
        );
        expect(notify).toHaveBeenCalledWith(
          "participants",
          "insert",
          expect.objectContaining({ id: participants.rows[0]?.id })
        );
        expect(notify).toHaveBeenCalledWith(
          "relationships",
          "insert",
          expect.objectContaining({ id: relationships.rows[0]?.id })
        );
        expect(notify).toHaveBeenCalledWith("memories", "delete", { id: memoryId });
        notify.mockRestore();
      });
      it("publishes the persisted metadata even if the caller mutates its input before commit", async () => {
        if (!pgliteManager) throw new Error("PGlite manager unavailable");
        const notify = vi.spyOn(pgliteManager, "notifyWrite");
        const id = randomUUID() as UUID;
        const metadata = { project: { name: "Persisted value" } };
        await adapter.transaction(async (tx) => {
          await tx.createEntities([{ id, agentId, names: ["Snapshot"], metadata }]);
          metadata.project.name = "Unsaved caller mutation";
          expect(notify).not.toHaveBeenCalled();
        });
        const [stored] = await adapter.getEntitiesByIds([id]);
        expect(stored.metadata).toEqual({ project: { name: "Persisted value" } });
        expect(notify).toHaveBeenCalledWith(
          "entities",
          "insert",
          expect.objectContaining({ id, metadata: stored.metadata })
        );
        notify.mockRestore();
      });
      it("reports committed publication failures and still publishes later writes", async () => {
        if (!pgliteManager) throw new Error("PGlite manager unavailable");
        const notify = vi.spyOn(pgliteManager, "notifyWrite");
        const failedId = randomUUID() as UUID;
        const nextId = randomUUID() as UUID;
        notify.mockImplementationOnce(() => {
          throw new Error("Write-back queue unavailable");
        });
        await expect(
          adapter.transaction(async (tx) => {
            await tx.createEntities([{ id: failedId, agentId, names: ["First"] }]);
            await tx.createEntities([{ id: nextId, agentId, names: ["Second"] }]);
          })
        ).rejects.toMatchObject({
          code: "TRANSACTION_PUBLICATION_FAILED",
          context: { committed: true, failedPublications: 1 },
        });
        expect(
          (await adapter.getEntitiesByIds([failedId, nextId]))?.map((entity) => entity.id).sort()
        ).toEqual([failedId, nextId].sort());
        expect(notify).toHaveBeenLastCalledWith(
          "entities",
          "insert",
          expect.objectContaining({ id: nextId })
        );
        notify.mockRestore();
      });
      it("publishes only committed writes after the outermost commit", async () => {
        if (!pgliteManager) throw new Error("PGlite manager unavailable");
        const notify = vi.spyOn(pgliteManager, "notifyWrite");
        const keptId = randomUUID() as UUID;
        const discardedId = randomUUID() as UUID;
        await adapter.transaction(async (tx) => {
          await tx.transaction(async (child) => {
            await child.createEntities([{ id: keptId, agentId, names: ["Kept"] }]);
          });
          await expect(
            tx.transaction(async (child) => {
              await child.createEntities([{ id: discardedId, agentId, names: ["Discarded"] }]);
              throw new Error("Discard this savepoint");
            })
          ).rejects.toThrow("Discard this savepoint");
          expect(notify).not.toHaveBeenCalled();
        });
        expect(await adapter.getEntitiesByIds([discardedId])).toEqual([]);
        expect(notify.mock.calls).toEqual([
          ["entities", "insert", expect.objectContaining({ id: keptId })],
        ]);
        notify.mockClear();
        await expect(
          adapter.transaction(async (tx) => {
            await tx.createEntities([{ id: discardedId, agentId, names: ["Discarded"] }]);
            throw new Error("Discard this transaction");
          })
        ).rejects.toThrow("Discard this transaction");
        expect(notify).not.toHaveBeenCalled();
      });
    }
  });
}
