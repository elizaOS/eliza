/**
 * Generated media counts toward the single organization storage quota
 * (#20956). Drives the real image executor and quota repository on PGlite
 * with a fake provider and bucket.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { installOrganizationPolicyTestSchema } from "../../db/repositories/organization-policy-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "00000000-0000-4000-8000-000000020956";
const IMAGE_BYTES = 100;

let closeDb: typeof import("../../db/client").closeDatabaseConnectionsForTests | null = null;
let dbWrite: typeof import("../../db/client").dbWrite;
let quota: typeof import("../../db/repositories/org-storage-quota").orgStorageQuotaRepository;
let media: typeof import("../storage/generated-media-storage");
let createExecutor: typeof import("./image-generation").createImageGenerationExecutor;
let defaultModel: string;
let putPublicObject: typeof import("../storage/r2-public-object").putPublicObject;

const objects = new Map<string, number>();
const generations: Array<{ id: string; result: Record<string, unknown> | null | undefined }> = [];
let admitted = 0;
let failDelete = false;

const bindings = {
  BLOB: {
    put: async (key: string, body: ArrayBuffer | ArrayBufferView) => {
      objects.set(key, body.byteLength);
    },
    delete: async (key: string) => {
      if (failDelete) throw new Error("R2 delete failed");
      objects.delete(key);
    },
  },
  R2_PUBLIC_HOST: "blob.example",
} as unknown as import("../storage/r2-public-object").PublicObjectBindings;

async function bytesUsed(): Promise<bigint> {
  const row = await quota.findByOrganization(ORG);
  return row?.bytes_used ?? 0n;
}

function executor(options: { failHistory?: boolean } = {}) {
  let sequence = 0;
  return createExecutor({
    getProvider: () => ({
      billingSource: "fal",
      generate: async () => ({
        dataUrl: "data:image/png;base64,AA==",
        bytes: new Uint8Array(IMAGE_BYTES),
        mimeType: "image/png",
        text: "",
      }),
    }),
    calculateCost: async () =>
      ({ totalCost: 0.05 }) as Awaited<
        ReturnType<import("./image-generation").ImageGenerationDependencies["calculateCost"]>
      >,
    assertSafe: async () => undefined,
    putObject: putPublicObject,
    storageQuota: quota,
    createGeneration: async (input) => {
      if (options.failHistory) throw new Error("history unavailable");
      const id = `generation-${generations.length + 1}`;
      generations.push({ id, result: input.result as Record<string, unknown> });
      return { id };
    },
    deleteGeneration: async () => undefined,
    billFlat: async () => undefined,
    randomUuid: () => `uuid-${++sequence}`,
    now: () => new Date(),
  });
}

function run(numImages: number, options: { failHistory?: boolean } = {}) {
  return executor(options)({
    input: { prompt: "a lighthouse", model: defaultModel, numImages },
    actor: { organizationId: ORG, userId: "user", apiKeyId: null },
    identity: { requestId: `request-${Date.now()}`, source: "http" },
    bindings,
    providerKeys: { FAL_KEY: "fal", ATLASCLOUD_API_KEY: "atlas" },
    admit: async () => {
      admitted += 1;
      return { kind: "platform" as const };
    },
  });
}

beforeAll(async () => {
  const client = await import("../../db/client");
  closeDb = client.closeDatabaseConnectionsForTests;
  dbWrite = client.dbWrite;
  await dbWrite.execute(sql.raw("CREATE TABLE organizations (id uuid PRIMARY KEY)"));
  await dbWrite.execute(
    sql.raw(
      "CREATE TABLE generations (id uuid PRIMARY KEY, organization_id uuid NOT NULL, status text NOT NULL, updated_at timestamp DEFAULT now())",
    ),
  );
  const migration = readFileSync(
    join(import.meta.dir, "../../db/migrations/0102_add_org_storage_quota.sql"),
    "utf8",
  );
  const ddl = migration
    .slice(0, migration.indexOf("-- Pricing entries for the storage proxy."))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  for (const statement of ddl.split(";")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement.trim()));
  }
  await installOrganizationPolicyTestSchema((query) =>
    client.getPgliteClientForTests().exec(query),
  );
  ({ orgStorageQuotaRepository: quota } = await import("../../db/repositories/org-storage-quota"));
  media = await import("../storage/generated-media-storage");
  ({ putPublicObject } = await import("../storage/r2-public-object"));
  ({ createImageGenerationExecutor: createExecutor } = await import("./image-generation"));
  ({ DEFAULT_IMAGE_MODEL_ID: defaultModel } = await import("./ai-pricing-definitions"));
}, 60_000);

beforeEach(async () => {
  objects.clear();
  generations.length = 0;
  admitted = 0;
  failDelete = false;
  await dbWrite.execute(sql`DELETE FROM generations`);
  await dbWrite.execute(sql`DELETE FROM org_storage_quota`);
  await dbWrite.execute(sql`DELETE FROM organizations`);
  await dbWrite.execute(sql`INSERT INTO organizations (id) VALUES (${ORG})`);
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("generated media and the storage quota (#20956)", () => {
  test("audio reserves only the byte view and cleanup releases its receipt", async () => {
    await quota.setBytesLimit(ORG, 3n, "admin:test");
    const result = await media.storeGeneratedAudio(
      bindings,
      ORG,
      {
        source: "bytes",
        bytes: new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4),
        contentType: "audio/wav",
      },
      "music",
      { source: "test" },
    );
    expect(result.stored.file_size).toBe(3);
    expect(result.stored.file_name).toEndWith(".wav");
    expect(await bytesUsed()).toBe(3n);
    expect([...objects.values()]).toEqual([3]);
    expect(result.storage).not.toBeNull();
    await media.discardGeneratedMediaObject(bindings, { organizationId: ORG, ...result.storage! });
    expect(await bytesUsed()).toBe(0n);
    expect(objects.size).toBe(0);
  });

  test("provider-hosted audio consumes no Cloud storage reservation", async () => {
    const result = await media.storeGeneratedAudio(
      bindings,
      ORG,
      {
        source: "hosted",
        url: "https://audio.example/track.mp3",
        fileSize: 10,
      },
      "sfx",
      {},
    );
    expect(result.storage).toBeNull();
    expect(result.stored.url).toBe("https://audio.example/track.mp3");
    expect(result.stored.file_size).toBe(10);
    expect(await bytesUsed()).toBe(0n);
    expect(objects.size).toBe(0);
  });

  test("generated images reserve their exact bytes in the one storage quota", async () => {
    await quota.setBytesLimit(ORG, 1_000n, "admin:test");
    const outcome = await run(2);
    expect(outcome.images).toHaveLength(2);
    expect(await bytesUsed()).toBe(BigInt(2 * IMAGE_BYTES));
    expect(generations.map((generation) => generation.result?.storageQuotaBytes)).toEqual([
      String(IMAGE_BYTES),
      String(IMAGE_BYTES),
    ]);
  });

  test("a full quota is refused before admission, so nothing is charged or stored", async () => {
    await quota.setBytesLimit(ORG, 50n, "admin:test");
    expect(await quota.tryReserveBytes(ORG, 50n)).toBe(50n);
    await expect(run(1)).rejects.toMatchObject({ status: 413, code: "storage_quota_exceeded" });
    expect(admitted).toBe(0);
    expect(objects.size).toBe(0);
  });

  test("output that no longer fits is never written and earlier images are released", async () => {
    await quota.setBytesLimit(ORG, 150n, "admin:test");
    await expect(run(2)).rejects.toMatchObject({ status: 413, code: "storage_quota_exceeded" });
    expect(admitted).toBe(1);
    expect(objects.size).toBe(0);
    expect(await bytesUsed()).toBe(0n);
  });

  test("a failed history write deletes the object and releases its bytes", async () => {
    await quota.setBytesLimit(ORG, 1_000n, "admin:test");
    await expect(run(1, { failHistory: true })).rejects.toThrow("history unavailable");
    expect(objects.size).toBe(0);
    expect(await bytesUsed()).toBe(0n);
  });

  test("deletion and quota release roll back together and a retry releases exactly once", async () => {
    const { generationsRepository } = await import("../../db/repositories/generations");
    const id = "00000000-0000-4000-8000-000000020957";
    await quota.setBytesLimit(ORG, 1000n, "admin:test");
    await quota.tryReserveBytes(ORG, 200n);
    await dbWrite.execute(
      sql`INSERT INTO generations (id, organization_id, status) VALUES (${id}, ${ORG}, 'completed')`,
    );
    await dbWrite.execute(
      sql.raw(
        "ALTER TABLE org_storage_quota ADD CONSTRAINT simulate_release_failure CHECK (bytes_used >= 200)",
      ),
    );
    await expect(generationsRepository.markDeletedOnce(id, "100")).rejects.toThrow();
    expect(await bytesUsed()).toBe(200n);
    await dbWrite.execute(
      sql.raw("ALTER TABLE org_storage_quota DROP CONSTRAINT simulate_release_failure"),
    );
    expect(await generationsRepository.markDeletedOnce(id, "100")).toBe(true);
    expect(await bytesUsed()).toBe(100n);
    expect(await generationsRepository.markDeletedOnce(id, "100")).toBe(false);
    expect(await bytesUsed()).toBe(100n);
  });

  test("a failed put compensates through the same quota that reserved the bytes", async () => {
    await quota.setBytesLimit(ORG, 1000n, "admin:test");
    let releases = 0;
    const customQuota = {
      hasHeadroom: (org: string) => quota.hasHeadroom(org),
      tryReserveBytes: (org: string, bytes: bigint) => quota.tryReserveBytes(org, bytes),
      releaseBytes: async (org: string, bytes: bigint) => {
        releases++;
        await quota.releaseBytes(org, bytes);
      },
    };
    await expect(
      media.putGeneratedMediaObject(
        bindings,
        { organizationId: ORG, key: "failed", body: new Uint8Array(100), contentType: "image/png" },
        customQuota,
        async () => {
          throw new Error("put failed");
        },
      ),
    ).rejects.toThrow("put failed");
    expect(releases).toBe(1);
    expect(await bytesUsed()).toBe(0n);
  });

  test("a release happens only after the object is confirmed deleted", async () => {
    await quota.setBytesLimit(ORG, 1_000n, "admin:test");
    await run(1);
    const [key] = [...objects.keys()];
    if (!key) throw new Error("expected a stored object");
    failDelete = true;
    expect(
      await media.discardGeneratedMediaObject(bindings, {
        organizationId: ORG,
        key,
        storageQuotaBytes: String(IMAGE_BYTES),
      }),
    ).toBe(false);
    expect(await bytesUsed()).toBe(BigInt(IMAGE_BYTES));
    failDelete = false;
    expect(
      await media.discardGeneratedMediaObject(bindings, {
        organizationId: ORG,
        key,
        storageQuotaBytes: String(IMAGE_BYTES),
      }),
    ).toBe(true);
    expect(await bytesUsed()).toBe(0n);
  });
});
