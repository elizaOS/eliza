/**
 * Proves account deletion's primary object-storage phase erases recorded
 * model-call payloads: private-store objects are enumerated by the
 * `{organizationId}/` prefix (orphans whose row is gone included), legacy
 * payloads in the general blob bucket go with the org's other objects, a failed
 * delete never reads as complete, and an unreachable private store parks the
 * request instead of reporting erasure. Storage metadata reconciliation (lease
 * and retention authority) is covered by account-deletion-storage tests and is
 * replaced here by a pass-through.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
for (const name of ["STORAGE_TRAJECTORIES_BUCKET", "R2_TRAJECTORIES_BUCKET"]) {
  delete process.env[name];
}

mock.module("./account-deletion-storage", () => ({
  reconcileAccountDeletionStorage: async (
    _context: unknown,
    providerIsAbsent: () => Promise<boolean>,
  ) => ((await providerIsAbsent()) ? "absent" : "provider_present"),
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import(
  "../../db/client"
);
const { runWithCloudBindingsAsync } = await import("../runtime/cloud-bindings");
const { createAccountDeletionProviderAdapters } = await import(
  "./account-deletion-provider-adapters"
);
type AccountDeletionProviderContext =
  import("./account-deletion-saga").AccountDeletionProviderContext;
type RuntimeR2Bucket = import("../storage/r2-runtime-binding").RuntimeR2Bucket;
type RuntimeR2ListOptions = import("../storage/r2-runtime-binding").RuntimeR2ListOptions;

const ORG_ID = "10000000-0000-4000-8000-0000000000f1";
const OTHER_ORG_ID = "10000000-0000-4000-8000-0000000000f2";

/** In-memory R2 bucket with prefix filtering and two-object pages. */
class MemoryBucket {
  readonly objects = new Map<string, string>();
  failDeletes = false;

  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }

  async put(key: string, value: unknown) {
    this.objects.set(key, String(value));
    return {};
  }

  async delete(key: string) {
    if (this.failDeletes) throw new Error("R2 delete failed");
    this.objects.delete(key);
    return {};
  }

  async list(options: RuntimeR2ListOptions = {}) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = keys.slice(start, start + 2);
    const next = start + page.length;
    return {
      objects: page.map((key) => ({ key, size: 1, etag: key })),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : undefined,
    };
  }
}

let generalBlob: MemoryBucket;
let privateBlob: MemoryBucket;

function context(): AccountDeletionProviderContext {
  return {
    requestId: "50000000-0000-4000-8000-0000000000f1",
    requestDigest: "a".repeat(64),
    userId: "20000000-0000-4000-8000-0000000000f1",
    organizationId: ORG_ID,
    stewardUserId: "steward-personal",
    lifecycleRevision: 2,
    phaseReceiptId: "60000000-0000-4000-8000-0000000000f1",
    phaseGeneration: 1,
    blob: generalBlob as unknown as RuntimeR2Bucket,
  };
}

const adapter = () => createAccountDeletionProviderAdapters().primary_object_storage;

function withPrivateStore<T>(fn: () => Promise<T>): Promise<T> {
  return runWithCloudBindingsAsync({ TRAJECTORY_BLOB: privateBlob }, fn);
}

beforeAll(async () => {
  await getPgliteClientForTests().exec(`
    CREATE TABLE llm_trajectories (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL,
      trajectory_payload_storage text NOT NULL DEFAULT 'inline', trajectory_payload_key text
    );
  `);
}, 120_000);

beforeEach(async () => {
  generalBlob = new MemoryBucket();
  privateBlob = new MemoryBucket();
  await getPgliteClientForTests().exec("DELETE FROM llm_trajectories");
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("account deletion recorded model-call payloads", () => {
  test("erases every private payload under the org prefix, orphans included, and legacy blob payloads", async () => {
    for (const day of ["2026-01-01", "2026-02-01", "2026-03-01"]) {
      privateBlob.objects.set(`${ORG_ID}/${day}/a.json`, "{}");
    }
    // An orphan: its row was already removed, only the prefix finds it.
    privateBlob.objects.set(`${ORG_ID}/2026-04-01/orphan.json`, "{}");
    privateBlob.objects.set(`${OTHER_ORG_ID}/2026-01-01/keep.json`, "{}");
    generalBlob.objects.set(`${ORG_ID}/2025-12-01/legacy.json`, "{}");
    generalBlob.objects.set(`${OTHER_ORG_ID}/2025-12-01/keep.json`, "{}");

    await withPrivateStore(async () => {
      expect(await adapter().inspect(context())).toEqual({ state: "needs_execution" });
      await adapter().execute(context());
      expect((await adapter().inspect(context())).state).toBe("complete");
      // Retry-safe: a repeated execution after erasure is a no-op.
      await adapter().execute(context());
      expect((await adapter().inspect(context())).state).toBe("complete");
    });

    expect([...privateBlob.objects.keys()]).toEqual([`${OTHER_ORG_ID}/2026-01-01/keep.json`]);
    expect([...generalBlob.objects.keys()]).toEqual([`${OTHER_ORG_ID}/2025-12-01/keep.json`]);
  });

  test("a failed private delete is surfaced and never inspected as complete", async () => {
    privateBlob.objects.set(`${ORG_ID}/2026-01-01/a.json`, "{}");
    privateBlob.failDeletes = true;

    await withPrivateStore(async () => {
      await expect(adapter().execute(context())).rejects.toThrow("R2 delete failed");
      expect(await adapter().inspect(context())).toEqual({ state: "needs_execution" });
    });
    expect(privateBlob.objects.size).toBe(1);
  });

  test("rows in a private store this deployment cannot reach park the request", async () => {
    await getPgliteClientForTests().exec(`
      INSERT INTO llm_trajectories (id, organization_id, trajectory_payload_storage, trajectory_payload_key)
        VALUES ('70000000-0000-4000-8000-0000000000f1', '${ORG_ID}', 'private_object', '${ORG_ID}/2026-01-01/x.json');
    `);

    expect(await adapter().inspect(context())).toEqual({
      state: "action_required",
      errorCode: "ACCOUNT_DELETION_TRAJECTORY_STORE_UNAVAILABLE",
    });
    await expect(adapter().execute(context())).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_TRAJECTORY_STORE_UNAVAILABLE",
    });
  });

  test("without a private store or private rows, only the general bucket decides", async () => {
    await getPgliteClientForTests().exec(`
      INSERT INTO llm_trajectories (id, organization_id, trajectory_payload_storage)
        VALUES ('70000000-0000-4000-8000-0000000000f2', '${ORG_ID}', 'inline');
    `);
    expect((await adapter().inspect(context())).state).toBe("complete");
  });
});
