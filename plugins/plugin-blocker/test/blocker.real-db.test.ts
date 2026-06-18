/**
 * Real-DB integration tests for the blocker `app_blocker` schema.
 *
 * IMPORTANT — what this test does NOT do, and why:
 * The blocker plugin's two services (`WebsiteBlockerService`,
 * `AppBlockerService`) drive the SelfControl hosts-file engine and native
 * mobile OS app-blocking; their state lives in the hosts file and in runtime
 * `Task` records, NOT in the `app_blocker` schema. No service or repository in
 * this plugin reads or writes `block_rules` / `active_sessions` / `allow_list`
 * (the drizzle schema is shipped + migrated, but there is no rule-persistence
 * code path reachable without real native blocking). There is therefore no
 * service- or repository-level rule round-trip to exercise — per the task's
 * gate #4, we test the persistent store directly against the live DB instead.
 *
 * This suite boots a REAL PGLite-backed AgentRuntime via
 * {@link createRealTestRuntime} with `blockerPlugin` registered, so the SQL
 * plugin's migration runner materializes the `app_blocker` tables from the
 * plugin `schema` field. It then drives the plugin's own drizzle table
 * definitions (`blockRulesTable` / `activeSessionsTable` / `allowListTable`)
 * through the live `runtime.db` handle: every assertion is an insert-then-
 * read-back round-trip against the real PGLite database — proving the schema
 * migrates and the column/type mapping is correct against a real Postgres
 * engine, not a mocked adapter.
 *
 * The hosts-file engine is kept away from `/etc/hosts` by the temp-hosts env
 * the real-runtime helper sets (SELFCONTROL_HOSTS_FILE_PATH /
 * WEBSITE_BLOCKER_HOSTS_FILE_PATH).
 *
 * Hermetic: no network, no native OS APIs, no /etc/hosts writes.
 */

import type { AgentRuntime, UUID } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
import {
  activeSessionsTable,
  allowListTable,
  blockRulesTable,
} from "../src/db/schema.ts";
import blockerPlugin from "../src/index.ts";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111" as UUID;

describe("app_blocker schema — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let db: NodePgDatabase;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "blocker-real-db-tests",
      // Registering the plugin makes runtime.initialize() run the SQL plugin's
      // migration for the `app_blocker` schema (the plugin `schema` field).
      plugins: [blockerPlugin],
    });
    runtime = testResult.runtime;
    db = runtime.db as NodePgDatabase;
    if (!db) {
      throw new Error("runtime.db unavailable — plugin-sql did not initialize");
    }
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("persists a block rule and reads it back from the live DB", async () => {
    const [inserted] = await db
      .insert(blockRulesTable)
      .values({
        agentId: runtime.agentId as UUID,
        entityId: ENTITY_ID,
        target: "website",
        pattern: "reddit.com",
        notes: "deep-work block",
        metadata: { source: "real-db-test" },
      })
      .returning();
    expect(inserted?.id).toBeTruthy();
    expect(inserted?.pattern).toBe("reddit.com");

    // Round-trip: the row is really in the DB, queried by (entity, target).
    const rows = await db
      .select()
      .from(blockRulesTable)
      .where(
        and(
          eq(blockRulesTable.entityId, ENTITY_ID),
          eq(blockRulesTable.target, "website"),
        ),
      );
    const fetched = rows.find((r) => r.id === inserted?.id);
    expect(fetched).toBeTruthy();
    expect(fetched?.pattern).toBe("reddit.com");
    expect(fetched?.notes).toBe("deep-work block");
    expect(fetched?.metadata).toEqual({ source: "real-db-test" });
    expect(fetched?.agentId).toBe(runtime.agentId);
    expect(fetched?.createdAt).toBeInstanceOf(Date);
  });

  it("persists an active session and reads it back from the live DB", async () => {
    const endsAt = new Date(Date.now() + 60 * 60 * 1000);
    const [session] = await db
      .insert(activeSessionsTable)
      .values({
        agentId: runtime.agentId as UUID,
        entityId: ENTITY_ID,
        target: "website",
        status: "active",
        rules: ["reddit.com", "news.ycombinator.com"],
        metadata: { reason: "focus" },
        endsAt,
      })
      .returning();
    expect(session?.id).toBeTruthy();

    const active = await db
      .select()
      .from(activeSessionsTable)
      .where(
        and(
          eq(activeSessionsTable.entityId, ENTITY_ID),
          eq(activeSessionsTable.status, "active"),
        ),
      );
    const fetched = active.find((s) => s.id === session?.id);
    expect(fetched).toBeTruthy();
    expect(fetched?.status).toBe("active");
    expect(fetched?.rules).toEqual(["reddit.com", "news.ycombinator.com"]);
    expect(fetched?.endsAt).toBeInstanceOf(Date);

    // Mutate (end the session) and confirm the UPDATE landed in the live DB.
    const endedAt = new Date();
    await db
      .update(activeSessionsTable)
      .set({ status: "ended", endedAt })
      .where(eq(activeSessionsTable.id, session?.id as UUID));
    const [reread] = await db
      .select()
      .from(activeSessionsTable)
      .where(eq(activeSessionsTable.id, session?.id as UUID));
    expect(reread?.status).toBe("ended");
    expect(reread?.endedAt).toBeInstanceOf(Date);
  });

  it("persists an allow-list entry and reads it back from the live DB", async () => {
    const [entry] = await db
      .insert(allowListTable)
      .values({
        agentId: runtime.agentId as UUID,
        entityId: ENTITY_ID,
        target: "website",
        pattern: "docs.elizaos.ai",
        reason: "work resource",
      })
      .returning();
    expect(entry?.id).toBeTruthy();

    const rows = await db
      .select()
      .from(allowListTable)
      .where(eq(allowListTable.entityId, ENTITY_ID));
    const fetched = rows.find((r) => r.id === entry?.id);
    expect(fetched).toBeTruthy();
    expect(fetched?.pattern).toBe("docs.elizaos.ai");
    expect(fetched?.reason).toBe("work resource");
  });

  it("deletes a block rule from the live DB", async () => {
    const [rule] = await db
      .insert(blockRulesTable)
      .values({
        agentId: runtime.agentId as UUID,
        entityId: ENTITY_ID,
        target: "app",
        pattern: "com.example.game",
      })
      .returning();
    expect(rule?.id).toBeTruthy();

    const deleted = await db
      .delete(blockRulesTable)
      .where(eq(blockRulesTable.id, rule?.id as UUID))
      .returning({ id: blockRulesTable.id });
    expect(deleted).toHaveLength(1);

    const after = await db
      .select()
      .from(blockRulesTable)
      .where(eq(blockRulesTable.id, rule?.id as UUID));
    expect(after).toHaveLength(0);
  });
});
