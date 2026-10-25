/**
 * Proves against real PostgreSQL semantics that delayed receipts cannot release
 * a destination fence after ownership has moved to a newer outbound call.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { twilioCallFenceKey, twilioCallFenceSource } from "./twilio-call-fence";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const DESTINATION = "+15551234567";
const CALL_A = "10000000-0000-4000-8000-00000000000a";
const CALL_B = "10000000-0000-4000-8000-00000000000b";
const CALL_C = "10000000-0000-4000-8000-00000000000c";

async function claimFence(
  database: PGlite,
  fenceKey: string,
  callId: string,
): Promise<boolean> {
  const result = await database.query<{ key: string }>(
    `INSERT INTO idempotency_keys (key, source, expires_at)
     VALUES ($1, $2, '9999-12-31T23:59:59.999Z')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [fenceKey, twilioCallFenceSource(callId)],
  );
  return result.rows.length === 1;
}

async function releaseFence(
  database: PGlite,
  fenceKey: string,
  callId: string,
): Promise<void> {
  await database.query(
    `DELETE FROM idempotency_keys WHERE key = $1 AND source = $2`,
    [fenceKey, twilioCallFenceSource(callId)],
  );
}

describe("Twilio outbound call fence ownership", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("keeps B fenced across delayed REST and callback releases for A", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(`
      CREATE TABLE idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key text NOT NULL UNIQUE,
        source text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        expires_at timestamp NOT NULL
      )
    `);
    const fenceKey = twilioCallFenceKey(ORGANIZATION_ID, USER_ID, DESTINATION);

    expect(await claimFence(database, fenceKey, CALL_A)).toBe(true);
    await releaseFence(database, fenceKey, CALL_A);
    expect(await claimFence(database, fenceKey, CALL_B)).toBe(true);

    // A's delayed REST completion and replayed signed callback both use the
    // same compare-and-delete authority and cannot release B's newer claim.
    await releaseFence(database, fenceKey, CALL_A);
    await releaseFence(database, fenceKey, CALL_A);

    const owner = await database.query<{ source: string }>(
      `SELECT source FROM idempotency_keys WHERE key = $1`,
      [fenceKey],
    );
    expect(owner.rows).toEqual([{ source: twilioCallFenceSource(CALL_B) }]);
    expect(await claimFence(database, fenceKey, CALL_C)).toBe(false);

    await releaseFence(database, fenceKey, CALL_B);
    expect(await claimFence(database, fenceKey, CALL_C)).toBe(true);
  });
});
