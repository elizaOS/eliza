/** Exercises the production phase-completion repository against real PostgreSQL, including lease loss while another transaction holds the phase row. Provider receipt validity is owned by the separate billing completion guards. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

setDefaultTimeout(120_000);
const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `phase_completion_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.searchParams.set("options", `-c search_path=${schema},pg_catalog,public`);
  process.env.DATABASE_URL = url.toString();
  process.env.TEST_DATABASE_URL = url.toString();
}
let database: Client;
let repository: typeof import("./account-deletion-requests").accountDeletionRequestsRepository;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function fixture(expires: string | null) {
  const requestId = randomUUID(),
    phaseReceiptId = randomUUID();
  await database.query("INSERT INTO account_deletion_requests VALUES($1,'processing',$2)", [
    requestId,
    "a".repeat(64),
  ]);
  await database.query(
    `INSERT INTO account_deletion_phase_receipts(id,request_id,phase,status,lease_generation,lease_expires_at,lease_owner_digest)
    VALUES($1,$2,'stripe','calling',3,$3,'worker')`,
    [phaseReceiptId, requestId, expires],
  );
  return {
    requestId,
    phaseReceiptId,
    generation: 3,
    providerReceiptDigest: "b".repeat(64),
    now: new Date("2000-01-01T00:00:00Z"),
  };
}
async function readPhase(id: string) {
  return (
    await database.query(
      "SELECT status,completed_at,lease_owner_digest,provider_receipt_digest FROM account_deletion_phase_receipts WHERE id=$1",
      [id],
    )
  ).rows[0];
}
describe.skipIf(!postgresUrl)("deletion provider phase completion lease", () => {
  beforeAll(async () => {
    database = new Client({ connectionString: postgresUrl });
    await database.connect();
    await database.query(`CREATE SCHEMA ${schema}`);
    await database.query(`SET search_path TO ${schema},pg_catalog,public`);
    await database.query(`
      CREATE TABLE account_deletion_requests(id uuid PRIMARY KEY,status text,request_digest text);
      CREATE TABLE account_deletion_phase_receipts(
        id uuid PRIMARY KEY,request_id uuid,phase text,status text,lease_generation bigint,
        lease_expires_at timestamp,lease_owner_digest text,provider_receipt_digest text,
        provider_acknowledged_at timestamp,reconciled_at timestamp,completed_at timestamp,
        retry_class text,next_attempt_at timestamp,last_error_code text,updated_at timestamp
      );
    `);
    repository = (await import("./account-deletion-requests")).accountDeletionRequestsRepository;
    close = (await import("../client")).closeDatabaseConnectionsForTests;
  });
  afterAll(async () => {
    if (close) await close();
    if (database) {
      await database.query(`DROP SCHEMA ${schema} CASCADE`);
      await database.end();
    }
  });
  test("expired, missing and infinite leases cannot complete even when caller time predates expiry", async () => {
    for (const expires of ["2001-01-01T00:00:00Z", null, "infinity", "-infinity"]) {
      const input = await fixture(expires);
      expect(await repository.completeProviderPhase(input)).toBe(false);
      expect(await readPhase(input.phaseReceiptId)).toMatchObject({
        status: "calling",
        completed_at: null,
        provider_receipt_digest: null,
        lease_owner_digest: "worker",
      });
    }
  });
  test("current lease completes using database time and stale generations preserve the live worker", async () => {
    const input = await fixture("2099-01-01T00:00:00Z");
    expect(await repository.completeProviderPhase({ ...input, generation: 2 })).toBe(false);
    expect((await readPhase(input.phaseReceiptId)).lease_owner_digest).toBe("worker");
    expect(await repository.completeProviderPhase(input)).toBe(true);
    const phase = await readPhase(input.phaseReceiptId);
    expect(phase.status).toBe("completed");
    expect(phase.provider_receipt_digest).toBe(input.providerReceiptDigest);
    expect(phase.lease_owner_digest).toBeNull();
    expect(new Date(phase.completed_at).getTime()).toBeGreaterThan(input.now.getTime());
    expect(await repository.completeProviderPhase(input)).toBe(false);
  });
  test("lease loss during a confirmed phase-row wait prevents completion", async () => {
    const input = await fixture("2099-01-01T00:00:00Z");
    const holder = new Client({ connectionString: postgresUrl });
    await holder.connect();
    await holder.query(`SET search_path TO ${schema},pg_catalog,public`);
    await holder.query("BEGIN");
    let holding = true;
    try {
      await holder.query("SELECT id FROM account_deletion_phase_receipts WHERE id=$1 FOR UPDATE", [
        input.phaseReceiptId,
      ]);
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      // error-policy:J1 Observe any repository rejection while the lock holder must still release its transaction.
      const completion = repository.completeProviderPhase(input).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        const deadline = Date.now() + 60_000;
        let blocked = false;
        while (Date.now() < deadline) {
          const rows = await database.query(
            "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
            [pid],
          );
          if (rows.rowCount) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        await holder.query(
          "UPDATE account_deletion_phase_receipts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [input.phaseReceiptId],
        );
      } finally {
        await holder.query("COMMIT");
        holding = false;
      }
      const result = await completion;
      if ("error" in result) throw result.error;
      expect(result.value).toBe(false);
      expect(await readPhase(input.phaseReceiptId)).toMatchObject({
        status: "calling",
        completed_at: null,
        provider_receipt_digest: null,
      });
    } finally {
      if (holding) await holder.query("ROLLBACK");
      await holder.end();
    }
  });
});
