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
import { eq, ne } from "drizzle-orm";
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

let accountDeletionRequestsRepository: typeof import("../../../db/repositories/account-deletion-requests").accountDeletionRequestsRepository;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let dbWrite: typeof import("../../../db/client").dbWrite;
let processIrreversibleAccountDeletionSaga: typeof import("../account-deletion-saga").processIrreversibleAccountDeletionSaga;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
  await pushSchemaToTestDb({ accountDeletionRequests, accountDeletionPhaseReceipts });
  ({ processIrreversibleAccountDeletionSaga } = await import("../account-deletion-saga"));
  ({ accountDeletionRequestsRepository } = await import(
    "../../../db/repositories/account-deletion-requests"
  ));
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
    irreversible_at: executeAfter,
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
  // The ten parked requests are reported, aged from when `domains` completed
  // for the oldest (T0), and none of them changed status.
  expect(result.deferredToOtherLane).toBe(10);
  expect(result.oldestDeferredAgeMs).toBe(24 * 3_600_000);
  const parked = await dbWrite
    .select({ status: accountDeletionRequests.status })
    .from(accountDeletionRequests)
    .where(ne(accountDeletionRequests.id, starved));
  expect(parked.map((row) => row.status)).toEqual(Array(10).fill("scheduled"));
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

test("an already-complete provider advances a scheduled request through the normal saga", async () => {
  const now = new Date();
  const requestId = await seedRequest(new Date(T0.getTime() - 86_400_000), 40);
  const [before] = await dbWrite
    .select()
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, requestId));
  expect(before.status).toBe("scheduled");

  // A stale identity cannot promote the request or acquire its phase.
  expect(
    await accountDeletionRequestsRepository.leasePhase({
      requestId,
      phase: "compute_containers",
      leaseOwnerDigest: digest("stale-worker"),
      now,
      leaseMilliseconds: 300_000,
      irreversibleRequest: {
        requestDigest: digest("different-request"),
        lifecycleRevision: before.lifecycle_revision,
        userId: before.user_id!,
        organizationId: before.organization_id!,
      },
    }),
  ).toBeUndefined();
  const [unchanged] = await dbWrite
    .select({ status: accountDeletionRequests.status })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, requestId));
  expect(unchanged.status).toBe("scheduled");

  const inspectedStatuses: string[] = [];
  let executions = 0;
  const adapter: AccountDeletionProviderAdapter = {
    async inspect(context) {
      const [request] = await dbWrite
        .select({ status: accountDeletionRequests.status })
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, context.requestId));
      inspectedStatuses.push(request.status);
      return { state: "complete", receiptDigest: digest(`complete:${context.requestId}`) };
    },
    async execute() {
      executions++;
    },
  };
  const adapters = Object.fromEntries(
    PROVIDER_PHASES.map((phase) => [phase, adapter]),
  ) as AccountDeletionProviderAdapters;
  const result = await processIrreversibleAccountDeletionSaga({
    limit: 1,
    blob: {} as RuntimeR2Bucket,
    adapters,
    allowedPhases: new Set(["compute_containers"]),
    now,
  });

  expect(result.progressed).toBe(1);
  expect(inspectedStatuses).toEqual(["processing"]);
  expect(executions).toBe(0);
  const [after] = await dbWrite
    .select({ status: accountDeletionRequests.status })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, requestId));
  expect(after.status).toBe("processing");
  const [phase] = await dbWrite
    .select({ status: accountDeletionPhaseReceipts.status })
    .from(accountDeletionPhaseReceipts)
    .where(
      eq(
        accountDeletionPhaseReceipts.idempotency_key_digest,
        digest(`${requestId}:compute_containers`),
      ),
    );
  expect(phase.status).toBe("completed");
});
