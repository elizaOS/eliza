/** Protected staging qualification; creates and removes only fresh fixture tenants. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sharedRecallFailureCode } from "./shared-recall-diagnostics";

const qualify = process.env.ELIZA_SHARED_RECALL_LIVE === "1" ? test : test.skip;

qualify(
  "live BGE vectors survive Shared memory writes and isolated recall",
  async () => {
    const commit = process.env.ELIZA_EMBEDDING_CLOUD_COMMIT;
    const key = process.env.ELIZAOS_CLOUD_API_KEY;
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_REF !== "refs/heads/staging" ||
      process.env.ELIZA_EMBEDDING_CLOUD_ENVIRONMENT !== "staging" ||
      !process.env.DATABASE_URL?.startsWith("postgres") ||
      !commit ||
      !/^[a-f0-9]{40}$/.test(commit) ||
      !key
    )
      throw new Error(
        "Protected staging, PostgreSQL, exact commit and API credential required",
      );

    const base = "https://api-staging.eliza.app";
    const verifyRelease = async () => {
      const response = await fetch(`${base}/api/health`, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        commit,
        environment: "staging",
      });
    };
    await verifyRelease();
    const { BGE_SMALL_VECTOR_SPACE, identifyEmbeddingVector } = await import(
      "@elizaos/core"
    );
    const embedTexts = async (texts: string[]) => {
      const response = await fetch(`${base}/api/v1/embeddings`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "bge-small-en-v1.5",
          input: texts,
          dimensions: 384,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        embedding_space: string;
        data: Array<{ index: number; embedding: number[] }>;
      };
      expect(payload.embedding_space).toBe(BGE_SMALL_VECTOR_SPACE);
      expect(payload.data).toHaveLength(texts.length);
      return payload.data.map((item, index) => {
        expect(item.index).toBe(index);
        expect(item.embedding).toHaveLength(384);
        expect(item.embedding.every(Number.isFinite)).toBe(true);
        return identifyEmbeddingVector(item.embedding, BGE_SMALL_VECTOR_SPACE);
      });
    };
    // Obtain vectors before creating fixtures so provider latency cannot leave idle tenants.
    const texts = [
      "The blue umbrella is stored in the hallway.",
      "I remember the blue umbrella.",
    ];
    const vectors = await embedTexts(texts);
    const [query] = await embedTexts([texts[0]]);
    // Bound each repository operation, including cleanup, before opening its pool.
    const databaseUrl = new URL(process.env.DATABASE_URL);
    databaseUrl.searchParams.set(
      "options",
      [
        databaseUrl.searchParams.get("options") ?? "",
        "-c statement_timeout=10000 -c lock_timeout=3000",
      ]
        .join(" ")
        .trim(),
    );
    process.env.DATABASE_URL = databaseUrl.toString();
    const { and, eq, inArray, sql } = await import("drizzle-orm");
    const { dbWrite, closeDatabaseConnectionsForTests } = await import(
      "../../shared/src/db/client"
    );
    const { organizations } = await import(
      "../../shared/src/db/schemas/organizations"
    );
    const { users } = await import("../../shared/src/db/schemas/users");
    const { sharedAgentMemories } = await import(
      "../../shared/src/db/schemas/shared-agent-memories"
    );
    const { SharedMemoryStore } = await import(
      "../../shared/src/lib/services/shared-runtime/shared-memory-store"
    );
    // Organization deletion is globally sealed during the billing cutover.
    // Check before creating fixtures; qualification must not bypass that guard.
    try {
      const control = await dbWrite.execute(
        sql`SELECT mode FROM auto_top_up_control WHERE singleton = true`,
      );
      if (control.rows.length !== 1 || control.rows[0]?.mode !== "durable") {
        console.info(
          "shared-recall-preflight=cleanup-unavailable code=AUTO_TOP_UP_CUTOVER_PAUSED",
        );
        throw new Error(
          "Shared recall fixtures require the organization cleanup gate to be open",
        );
      }
    } catch (error) {
      await closeDatabaseConnectionsForTests();
      throw error;
    }
    const nonce = randomUUID();
    // Only this random fixture marker is released from the otherwise private log.
    console.info(`shared-recall-fixture=${nonce}`);
    const fixtures = [0, 1].map((index) => ({
      organizationId: randomUUID(),
      userId: randomUUID(),
      slug: `recall-qualification-${nonce}-${index}`,
    }));
    const agentKey = `recall-qualification-${nonce}`;
    const roomKey = `${agentKey}:room`;
    const store = (index: number, room = roomKey) =>
      new SharedMemoryStore(
        { ...fixtures[index], agentKey, roomKey: room },
        undefined,
        undefined,
        {
          model: "bge-small-en-v1.5",
          embedTexts: async (input) => {
            expect(input).toEqual(texts);
            return vectors;
          },
        },
      );
    const ids = { user: randomUUID(), assistant: randomUUID() };
    const orgIds = fixtures.map((fixture) => fixture.organizationId);
    const cleanupFixtures = async () => {
      try {
        // Both random identity and qualification slug must match; no existing tenant is targeted.
        for (const fixture of fixtures) {
          await dbWrite
            .delete(organizations)
            .where(
              and(
                eq(organizations.id, fixture.organizationId),
                eq(organizations.slug, fixture.slug),
              ),
            );
        }
        expect(
          await dbWrite
            .select({ id: sharedAgentMemories.id })
            .from(sharedAgentMemories)
            .where(inArray(sharedAgentMemories.organization_id, orgIds)),
        ).toEqual([]);
        expect(
          await dbWrite
            .select({ id: users.id })
            .from(users)
            .where(
              inArray(
                users.id,
                fixtures.map((fixture) => fixture.userId),
              ),
            ),
        ).toEqual([]);
        expect(
          await dbWrite
            .select({ id: organizations.id })
            .from(organizations)
            .where(inArray(organizations.id, orgIds)),
        ).toEqual([]);
        console.info("shared-recall-phase=cleanup status=passed code=NONE");
      } catch (error) {
        console.info(
          `shared-recall-phase=cleanup status=failed code=${sharedRecallFailureCode(error)}`,
        );
        throw error;
      } finally {
        await closeDatabaseConnectionsForTests();
      }
    };
    let phase = "create-fixtures";
    try {
      await dbWrite.transaction(async (tx) => {
        for (const fixture of fixtures) {
          await tx.insert(organizations).values({
            id: fixture.organizationId,
            name: "Shared recall qualification",
            slug: fixture.slug,
            is_active: false,
          });
          await tx.insert(users).values({
            id: fixture.userId,
            organization_id: fixture.organizationId,
            steward_user_id: fixture.slug,
          });
        }
      });
      const pair = {
        userMessage: texts[0],
        assistantReply: texts[1],
        messageIds: ids,
      };
      phase = "record-turns";
      await store(0).recordTurnPair(pair);
      await store(0).recordTurnPair(pair);
      phase = "verify-rows";
      const rows = await dbWrite
        .select()
        .from(sharedAgentMemories)
        .where(
          eq(sharedAgentMemories.organization_id, fixtures[0].organizationId),
        );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.embedding_model).toBe(BGE_SMALL_VECTOR_SPACE);
        expect(row.embedding).toHaveLength(384);
      }
      phase = "recall";
      const hits = await store(0).searchByEmbedding(query, 10);
      expect(hits).toHaveLength(2);
      expect(hits[0].id).toBe(ids.user);
      expect(hits[0].distance).toBeLessThan(0.00001);
      phase = "isolation";
      expect(
        await store(0, `${roomKey}:other`).searchByEmbedding(query, 10),
      ).toEqual([]);
      expect(await store(1).searchByEmbedding(query, 10)).toEqual([]);
      for (const mismatch of [
        { organizationId: fixtures[1].organizationId },
        { userId: fixtures[1].userId },
        { agentKey: `${agentKey}:other` },
      ]) {
        const isolated = new SharedMemoryStore({
          ...fixtures[0],
          agentKey,
          roomKey,
          ...mismatch,
        });
        expect(await isolated.searchByEmbedding(query, 10)).toEqual([]);
      }
      phase = "verify-release";
      await verifyRelease();
      console.info(
        "shared-recall-phase=verify-release status=passed code=NONE",
      );
    } catch (error) {
      console.info(
        `shared-recall-phase=${phase} status=failed code=${sharedRecallFailureCode(error)}`,
      );
      throw error;
    } finally {
      await cleanupFixtures();
    }
  },
  300_000,
);
