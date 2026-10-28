/**
 * The irreversible saga runs in two lanes: the Worker cron owns every provider
 * phase except `spools` and `secondary_backups`, which belong to the backup
 * catalog daemon. A request whose head phase belongs to the other lane is
 * skipped without a write, so it stays first in the due set. Ten such rows
 * must not stop the cron lane from reaching an eleventh request whose head
 * phase it can run. Real PGlite; provider adapters are stubs.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "account-deletion-lane-starvation.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accountDeletionPhaseReceipts } from "../../../db/schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../../../db/schemas/account-deletion-requests";
import type { RuntimeR2Bucket } from "../../storage/r2-runtime-binding";
import type {
  AccountDeletionProviderAdapter,
  AccountDeletionProviderAdapters,
  AccountDeletionProviderPhase,
} from "../account-deletion-saga";

const PHASES: ReadonlyArray<[AccountDeletionProviderPhase | "database_erasure", number]> = [
  ["steward_deactivation", 2],
  ["stripe", 10],
  ["domains", 20],
  ["spools", 30],
  ["secondary_backups", 40],
  ["compute_containers", 50],
  ["github_repositories", 60],
  ["connector_credentials", 70],
  ["voice_credentials", 80],
  ["primary_object_storage", 90],
  ["vault_key_bindings", 100],
  ["other_grants", 110],
  ["steward_deletion", 120],
  ["database_erasure", 130],
];
const PROVIDER_PHASES = PHASES.map(([phase]) => phase).filter(
  (phase): phase is AccountDeletionProviderPhase => phase !== "database_erasure",
);
/** The Worker cron lane: every provider phase except the backup authority's two. */
const CRON_LANE = new Set(
  PROVIDER_PHASES.filter((phase) => phase !== "spools" && phase !== "secondary_backups"),
);
const T0 = new Date("2026-10-01T00:00:00.000Z");

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let dbWrite: typeof import("../../../db/client").dbWrite;
let processIrreversibleAccountDeletionSaga: typeof import("../account-deletion-saga").processIrreversibleAccountDeletionSaga;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
  await pushSchemaToTestDb({ accountDeletionRequests, accountDeletionPhaseReceipts });
  ({ processIrreversibleAccountDeletionSaga } = await import("../account-deletion-saga"));
});

afterAll(async () => {
  await closeDb();
});

/** A scheduled request whose phases up to `completedThrough` are done and the rest pending. */
async function seedRequest(executeAfter: Date, completedThrough: number): Promise<string> {
  const id = randomUUID();
  await dbWrite.insert(accountDeletionRequests).values({
    id,
    user_id: randomUUID(),
    organization_id: randomUUID(),
    steward_user_id: `subject_${id}`,
    status: "scheduled",
    request_digest: digest(`request:${id}`),
    execute_after: executeAfter,
    recovery_expires_at: executeAfter,
  });
  await dbWrite.insert(accountDeletionPhaseReceipts).values(
    PHASES.map(([phase, order]) => ({
      request_id: id,
      phase,
      phase_order: order,
      status: order <= completedThrough ? "completed" : "pending",
      idempotency_key_digest: digest(`${id}:${phase}`),
      ...(order <= completedThrough
        ? { completed_at: executeAfter, provider_receipt_digest: digest(`receipt:${id}:${phase}`) }
        : {}),
    })),
  );
  return id;
}

test("ten requests parked at the backup lane's phase do not starve a request the cron lane can run", async () => {
  // R1..R10 wait on `spools` (the daemon's phase) and sort first by execute_after.
  for (let i = 0; i < 10; i++) {
    await seedRequest(new Date(T0.getTime() + i * 3_600_000), 20);
  }
  // R11 still needs its first provider phase, which the cron lane owns.
  const starved = await seedRequest(new Date(T0.getTime() + 10 * 3_600_000), 1);

  const inspected: Array<{ phase: AccountDeletionProviderPhase; requestId: string }> = [];
  const adapter = (phase: AccountDeletionProviderPhase): AccountDeletionProviderAdapter => ({
    inspect: async (context) => {
      inspected.push({ phase, requestId: context.requestId });
      return { state: "complete", receiptDigest: digest(`done:${context.requestId}:${phase}`) };
    },
    execute: async () => undefined,
  });
  const adapters = Object.fromEntries(
    PROVIDER_PHASES.map((phase) => [phase, adapter(phase)]),
  ) as AccountDeletionProviderAdapters;

  const result = await processIrreversibleAccountDeletionSaga({
    limit: 10,
    blob: {} as RuntimeR2Bucket,
    adapters,
    allowedPhases: CRON_LANE,
    now: new Date(T0.getTime() + 24 * 3_600_000),
  });

  expect(inspected).toEqual([{ phase: "steward_deactivation", requestId: starved }]);
  expect(result.progressed).toBe(1);
  const [receipt] = await dbWrite
    .select({ status: accountDeletionPhaseReceipts.status })
    .from(accountDeletionPhaseReceipts)
    .where(
      eq(
        accountDeletionPhaseReceipts.idempotency_key_digest,
        digest(`${starved}:steward_deactivation`),
      ),
    );
  expect(receipt?.status).toBe("completed");
});
