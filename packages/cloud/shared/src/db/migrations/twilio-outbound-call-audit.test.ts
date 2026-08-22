/** Applies the outbound Call-me audit migration to real PGlite. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await Bun.file(
  new URL("./0300_twilio_outbound_call_audit.sql", import.meta.url),
).text();
const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(migration);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0300 Twilio outbound call audit", () => {
  test("retains a pre-provider terminal failure without inventing a CallSid", async () => {
    const db = await database();
    await db.exec(`INSERT INTO twilio_outbound_calls (
      id, request_digest, account_sid, organization_id, user_id,
      from_number, to_number, call_status, terminal_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 'request-1', 'AC123',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '+14484080429', '+14155550100', 'provider-error', now()
    )`);

    const result = await db.query<{ call_sid: string | null; call_status: string }>(
      "SELECT call_sid, call_status FROM twilio_outbound_calls",
    );
    expect(result.rows).toEqual([{ call_sid: null, call_status: "provider-error" }]);
  });

  test("rejects impossible terminal history and duplicate request authority", async () => {
    const db = await database();
    await expect(
      db.exec(`INSERT INTO twilio_outbound_calls (
        id, request_digest, account_sid, organization_id, user_id,
        from_number, to_number, call_status, terminal_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 'request-1', 'AC123',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '+14484080429', '+14155550100', 'completed', now()
      )`),
    ).rejects.toThrow();

    await db.exec(`INSERT INTO twilio_outbound_calls (
      id, request_digest, call_sid, account_sid, organization_id, user_id,
      from_number, to_number, call_status, terminal_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 'request-1',
      'CA11111111111111111111111111111111', 'AC123',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '+14484080429', '+14155550100', 'completed', now()
    )`);
    await expect(
      db.exec(`INSERT INTO twilio_outbound_calls (
        id, request_digest, account_sid, organization_id, user_id,
        from_number, to_number
      ) VALUES (
        '44444444-4444-4444-8444-444444444444', 'request-1', 'AC123',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '+14484080429', '+14155550100'
      )`),
    ).rejects.toThrow();
  });

  test("deduplicates signed receipts by digest and CallSid sequence", async () => {
    const db = await database();
    await db.exec(`INSERT INTO twilio_outbound_calls (
      id, request_digest, call_sid, account_sid, organization_id, user_id,
      from_number, to_number, call_status
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 'request-1',
      'CA11111111111111111111111111111111', 'AC123',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '+14484080429', '+14155550100', 'ringing'
    )`);
    await db.exec(`INSERT INTO twilio_call_status_events (
      event_digest, outbound_call_id, call_sid, call_status, sequence_number
    ) VALUES (
      'event-1', '11111111-1111-4111-8111-111111111111',
      'CA11111111111111111111111111111111', 'ringing', 1
    )`);
    await expect(
      db.exec(`INSERT INTO twilio_call_status_events (
        event_digest, outbound_call_id, call_sid, call_status, sequence_number
      ) VALUES (
        'event-2', '11111111-1111-4111-8111-111111111111',
        'CA11111111111111111111111111111111', 'completed', 1
      )`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO twilio_call_status_events (
        event_digest, outbound_call_id, call_sid, call_status, sequence_number
      ) VALUES (
        'event-1', '11111111-1111-4111-8111-111111111111',
        'CA11111111111111111111111111111111', 'completed', 2
      )`),
    ).rejects.toThrow();
  });
});
