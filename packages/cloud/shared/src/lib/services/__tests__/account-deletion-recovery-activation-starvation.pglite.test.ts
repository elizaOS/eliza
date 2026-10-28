/**
 * When a deletion request's recovery window ends, the cron activates it.
 * Some outcomes leave the request due without a write (`account_unavailable`,
 * `provider_work_in_flight`), so it keeps its place at the front of the due
 * set. Ten such requests must not stop the cron from reaching an eleventh
 * whose activation it can decide. Real PGlite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("this test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accountDeletionRequests } from "../../../db/schemas/account-deletion-requests";
import { organizations } from "../../../db/schemas/organizations";
import { providerAdmissions } from "../../../db/schemas/provider-admissions";
import { users } from "../../../db/schemas/users";

const T0 = new Date("2026-10-01T00:00:00.000Z");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let dbWrite: typeof import("../../../db/client").dbWrite;
let activateExpiredRecoveryRequests: typeof import("../account-deletion").activateExpiredRecoveryRequests;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
  await pushSchemaToTestDb({ organizations, users, accountDeletionRequests, providerAdmissions });
  ({ activateExpiredRecoveryRequests } = await import("../account-deletion"));
});

afterAll(async () => {
  await closeDb();
});

async function seedRequest(input: {
  executeAfter: Date;
  organizationId: string;
  userId: string;
}): Promise<string> {
  const id = randomUUID();
  await dbWrite.insert(accountDeletionRequests).values({
    id,
    user_id: input.userId,
    organization_id: input.organizationId,
    steward_user_id: `subject_${id}`,
    status: "reserved",
    request_digest: digest(`request:${id}`),
    execute_after: input.executeAfter,
    recovery_expires_at: input.executeAfter,
  });
  return id;
}

test("ten expired requests the cron cannot decide do not starve an eleventh it can", async () => {
  // R1..R10: their organization row is gone, so activation answers
  // `account_unavailable` and writes nothing. They sort first.
  for (let i = 0; i < 10; i++) {
    await seedRequest({
      executeAfter: new Date(T0.getTime() + i * 3_600_000),
      organizationId: randomUUID(),
      userId: randomUUID(),
    });
  }
  // R11: a shared organization with two members, so activation must park it
  // as `action_required` (ownership transfer needed).
  const organizationId = randomUUID();
  const ownerId = randomUUID();
  await dbWrite
    .insert(organizations)
    .values({ id: organizationId, name: "Acme", slug: `acme-${organizationId}` });
  await dbWrite.insert(users).values([
    {
      id: ownerId,
      steward_user_id: `steward_${ownerId}`,
      organization_id: organizationId,
      role: "owner",
    },
    {
      id: randomUUID(),
      steward_user_id: `steward_${randomUUID()}`,
      organization_id: organizationId,
      role: "member",
    },
  ]);
  const starved = await seedRequest({
    executeAfter: new Date(T0.getTime() + 10 * 3_600_000),
    organizationId,
    userId: ownerId,
  });

  const result = await activateExpiredRecoveryRequests({
    now: new Date(T0.getTime() + 24 * 3_600_000),
    limit: 10,
  });

  expect(result.actionRequired).toBe(1);
  const [row] = await dbWrite
    .select({
      status: accountDeletionRequests.status,
      code: accountDeletionRequests.last_error_code,
    })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, starved));
  expect(row).toEqual({ status: "action_required", code: "TRANSFER_REQUIRED" });
});
