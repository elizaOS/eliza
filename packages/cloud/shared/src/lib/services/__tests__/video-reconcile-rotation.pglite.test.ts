/** The every-minute video reconcile sweep reads a batch of pending video settlements. Rows it cannot settle (a status probe that keeps failing) must not take every batch, or newer pending videos are never settled or refunded. Real reconcile sweep and generations repository on PGlite; the video provider's status probe is a test provider. */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("video-reconcile-rotation.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { generationsRepository } from "../../../db/repositories/generations";
import { apiKeys } from "../../../db/schemas/api-keys";
import { generations } from "../../../db/schemas/generations";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { users } from "../../../db/schemas/users";
import { registerVideoProvider } from "../../providers/video/registry";
import {
  VIDEO_PENDING_SETTLEMENT_MARKER,
  VIDEO_RECONCILE_ATTEMPTED_AT_KEY,
} from "../../providers/video/types";
import { setRuntimeR2Bucket } from "../../storage/r2-runtime-binding";
import { reconcilePendingVideoGenerations } from "../video-generation-reconcile";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { apply } = await pushSchema(
    { organizations, users, apiKeys, usageRecords, generations } as never,
    dbWrite as never,
  );
  await apply();
}, 120_000);

afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDb();
});

beforeEach(async () => {
  setRuntimeR2Bucket(null);
  await dbWrite.delete(generations);
});

test("a sweep reaches a newer pending video behind rows whose probe keeps failing", async () => {
  const probed: string[] = [];
  registerVideoProvider({
    billingSource: "rotation-test",
    getJobStatus: async ({ requestId }: { requestId: string }) => {
      probed.push(requestId);
      throw new Error("upstream status unavailable");
    },
  } as never);

  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: `org-${crypto.randomUUID()}`, credit_balance: "5.000000" })
    .returning();
  await dbWrite.insert(generations).values(
    ["job-old-1", "job-old-2", "job-new"].map((jobId, index) => ({
      organization_id: organization.id,
      type: "video",
      model: "test-video-model",
      provider: "rotation-test",
      prompt: "a test render",
      status: "pending",
      job_id: jobId,
      created_at: new Date(Date.now() - (3 - index) * 60_000),
      metadata: {
        settlement_marker: VIDEO_PENDING_SETTLEMENT_MARKER,
        reservation_transaction_id: crypto.randomUUID(),
        reserved_amount: 1,
        billed_cost: 1,
        billing_source: "rotation-test",
      },
    })) as never,
  );

  // Two minute ticks with room for two rows each.
  await reconcilePendingVideoGenerations({ apiKeys: {}, batchSize: 2 });
  await reconcilePendingVideoGenerations({ apiKeys: {}, batchSize: 2 });

  expect(probed.slice(0, 2).sort()).toEqual(["job-old-1", "job-old-2"]);
  expect(probed.slice(2)).toContain("job-new");
}, 60_000);

test("missing unused payloads do not block video settlement rotation or receipts", async () => {
  const probed: string[] = [];
  const fetched: string[] = [];
  setRuntimeR2Bucket({
    get: async (key) => {
      fetched.push(key);
      return null;
    },
    put: async () => {
      throw new Error("Unexpected object upload");
    },
    delete: async () => {
      throw new Error("Unexpected object deletion");
    },
  });
  registerVideoProvider({
    billingSource: "rotation-test",
    getJobStatus: async ({ requestId }: { requestId: string }) => {
      probed.push(requestId);
      throw new Error("upstream status unavailable");
    },
  } as never);
  const [organization] = await dbWrite
    .insert(organizations)
    .values({
      name: "Missing payload",
      slug: `org-${crypto.randomUUID()}`,
      credit_balance: "5.000000",
    })
    .returning();
  const rows = await dbWrite
    .insert(generations)
    .values(
      ["missing-old-1", "missing-old-2", "later-job"].map((jobId, index) => ({
        organization_id: organization.id,
        type: "video",
        model: "test-video-model",
        provider: "rotation-test",
        prompt: "original inline preview",
        prompt_storage: "r2",
        prompt_key: `missing-${index}`,
        status: "pending",
        job_id: jobId,
        created_at: new Date(Date.now() - (3 - index) * 60_000),
        metadata: {
          settlement_marker: VIDEO_PENDING_SETTLEMENT_MARKER,
          reservation_transaction_id: crypto.randomUUID(),
          reserved_amount: 1,
          billed_cost: 1,
          billing_source: "rotation-test",
        },
      })),
    )
    .returning();
  const projection = await generationsRepository.listPendingVideoSettlements(2);
  expect(Object.keys(projection[0] ?? {}).sort()).toEqual(
    ["id", "organization_id", "user_id", "model", "job_id", "metadata", "created_at"].sort(),
  );
  expect(projection[0]?.metadata).toEqual(rows[0]?.metadata);
  expect((await reconcilePendingVideoGenerations({ apiKeys: {}, batchSize: 2 })).skipped).toBe(2);
  expect((await reconcilePendingVideoGenerations({ apiKeys: {}, batchSize: 2 })).skipped).toBe(2);
  expect(probed.slice(0, 2).sort()).toEqual(["missing-old-1", "missing-old-2"]);
  expect(probed.slice(2)).toContain("later-job");
  expect(fetched).toEqual([]);
  const after = await dbWrite.select().from(generations);
  for (const row of after) {
    const original = rows.find((value) => value.id === row.id);
    expect(row.metadata[VIDEO_RECONCILE_ATTEMPTED_AT_KEY]).toBeString();
    const { [VIDEO_RECONCILE_ATTEMPTED_AT_KEY]: _attempted, ...metadata } = row.metadata;
    expect(metadata).toEqual(original?.metadata);
  }
  await expect(generationsRepository.findById(rows[0]!.id)).rejects.toMatchObject({
    code: "OBJECT_STORAGE_FIELD_UNAVAILABLE",
  });
});

test("a missing coordinator row cannot produce a successful mutation receipt", async () => {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({
      name: "Removed generation",
      slug: `org-${crypto.randomUUID()}`,
      credit_balance: "5.000000",
    })
    .returning();
  const [generation] = await dbWrite
    .insert(generations)
    .values({
      organization_id: organization.id,
      type: "video",
      model: "test-video-model",
      provider: "rotation-test",
      prompt: "prompt",
      status: "pending",
      job_id: "removed-job",
      metadata: {
        settlement_marker: VIDEO_PENDING_SETTLEMENT_MARKER,
        reservation_transaction_id: crypto.randomUUID(),
        reserved_amount: 1,
        billed_cost: 1,
        billing_source: "rotation-test",
      },
    })
    .returning();
  registerVideoProvider({
    billingSource: "rotation-test",
    getJobStatus: async () => {
      await dbWrite.delete(generations).where(eq(generations.id, generation.id));
      throw new Error("upstream status unavailable");
    },
  } as never);
  await expect(
    reconcilePendingVideoGenerations({ apiKeys: {}, batchSize: 1 }),
  ).rejects.toMatchObject({
    code: "GENERATION_SETTLEMENT_NOT_PERSISTED",
  });
});
