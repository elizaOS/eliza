/**
 * Real-DB coverage for the cross-tenant guard on payment-settlement callbacks
 * (#10253).
 *
 * A charge's `callback_channel.{roomId, agentId}` is attacker-controlled — set by
 * whoever created the charge and stored verbatim. The settlement dispatch writes
 * a `role:'agent'` "Payment went through for $X." memory into that room. Without
 * a guard, an attacker could create their own app + charge, point the channel at
 * a VICTIM org's room, self-pay, and have a forged agent message injected into
 * the victim's conversation.
 *
 * This suite runs the REAL room→org resolution
 * (`eliza_room_characters → user_characters`) and the REAL
 * `appChargeCallbacksService.dispatch` path against in-process PGlite, seeding
 * real rows and asserting the observable effect: the downstream memory write is
 * performed for a same-tenant channel and REFUSED for a cross-tenant or unmapped
 * channel. The only thing stubbed is `memoriesRepository.create` — the
 * downstream sink being gated, NOT the authorization logic under test.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const PGLITE_TIMEOUT = 60000;

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b1";
const USER_A = "00000000-0000-0000-0000-0000000000a2";
const USER_B = "00000000-0000-0000-0000-0000000000b2";
const CHAR_A = "00000000-0000-0000-0000-0000000000a3";
const CHAR_B = "00000000-0000-0000-0000-0000000000b3";
const ROOM_A = "00000000-0000-0000-0000-0000000000a4";
const ROOM_B = "00000000-0000-0000-0000-0000000000b4";
const AGENT_A = "00000000-0000-0000-0000-0000000000a5";
const APP_ID = "00000000-0000-0000-0000-00000000ff01";
const CHARGE_ID = "00000000-0000-0000-0000-00000000ff02";
const UNMAPPED_ROOM = "00000000-0000-0000-0000-00000000dead";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let appChargeCallbacksService: typeof import("../app-charge-callbacks").appChargeCallbacksService;
let callbackRoomBelongsToOrganization: typeof import("../callback-channel-authz").callbackRoomBelongsToOrganization;
let memoriesRepository: typeof import("../../../db/repositories/agents/memories").memoriesRepository;
let createSpy: ReturnType<typeof spyOn> | undefined;
let pgliteReady = true;

async function seedCharge(creatorOrg: string, roomId: string): Promise<void> {
  await dbWrite.execute(`DELETE FROM crypto_payments WHERE id = '${CHARGE_ID}';`);
  const metadata = JSON.stringify({
    kind: "app_charge_request",
    app_id: APP_ID,
    amount_usd: 5,
    payment_context: "any_payer",
    callback_channel: { roomId, agentId: AGENT_A, source: "payment" },
  }).replace(/'/g, "''");
  await dbWrite.execute(
    `INSERT INTO crypto_payments
       (id, organization_id, user_id, payment_address, token, network,
        expected_amount, credits_to_add, status, expires_at, metadata)
     VALUES
       ('${CHARGE_ID}', '${creatorOrg}', '${USER_A}', 'addr', 'USDC', 'base',
        '5', '5', 'confirmed', now() + interval '1 day', '${metadata}'::jsonb);`,
  );
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ appChargeCallbacksService } = await import("../app-charge-callbacks"));
    ({ callbackRoomBelongsToOrganization } = await import("../callback-channel-authz"));
    ({ memoriesRepository } = await import("../../../db/repositories/agents/memories"));

    const ddl = [
      `CREATE TABLE IF NOT EXISTS user_characters (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        user_id uuid NOT NULL,
        name text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS eliza_room_characters (
        room_id uuid PRIMARY KEY,
        character_id uuid NOT NULL,
        user_id uuid NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS crypto_payments (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        user_id uuid,
        payment_address text NOT NULL,
        token_address text,
        token text NOT NULL,
        network text NOT NULL,
        expected_amount text NOT NULL,
        received_amount text,
        credits_to_add text NOT NULL,
        transaction_hash text,
        block_number text,
        status text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        confirmed_at timestamp,
        expires_at timestamp NOT NULL,
        metadata jsonb DEFAULT '{}'
      )`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);

    // Two tenants: orgA owns charA in roomA; orgB owns charB in roomB.
    await dbWrite.execute(`DELETE FROM user_characters;`);
    await dbWrite.execute(`DELETE FROM eliza_room_characters;`);
    await dbWrite.execute(
      `INSERT INTO user_characters (id, organization_id, user_id, name) VALUES
        ('${CHAR_A}', '${ORG_A}', '${USER_A}', 'Char A'),
        ('${CHAR_B}', '${ORG_B}', '${USER_B}', 'Char B');`,
    );
    await dbWrite.execute(
      `INSERT INTO eliza_room_characters (room_id, character_id, user_id) VALUES
        ('${ROOM_A}', '${CHAR_A}', '${USER_A}'),
        ('${ROOM_B}', '${CHAR_B}', '${USER_B}');`,
    );
  } catch (error) {
    pgliteReady = false;
    console.warn("[app-charge-callback-cross-tenant] PGlite unavailable, skipping:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  createSpy?.mockRestore();
  if (closeDb) await closeDb();
});

describe("callbackRoomBelongsToOrganization — room→org authority", () => {
  test("same-tenant (room owned by the charge org) → authorized", async () => {
    if (!pgliteReady) return;
    expect(
      await callbackRoomBelongsToOrganization({
        roomId: ROOM_A,
        chargeOrganizationId: ORG_A,
        logContext: "test",
      }),
    ).toBe(true);
  });

  test("cross-tenant (room owned by a different org) → refused", async () => {
    if (!pgliteReady) return;
    expect(
      await callbackRoomBelongsToOrganization({
        roomId: ROOM_A,
        chargeOrganizationId: ORG_B,
        logContext: "test",
      }),
    ).toBe(false);
  });

  test("unmapped room (no character mapping) → refused (fail-closed)", async () => {
    if (!pgliteReady) return;
    expect(
      await callbackRoomBelongsToOrganization({
        roomId: UNMAPPED_ROOM,
        chargeOrganizationId: ORG_A,
        logContext: "test",
      }),
    ).toBe(false);
  });
});

describe("appChargeCallbacksService.dispatch — settlement memory write is gated", () => {
  beforeEach(() => {
    if (!pgliteReady) return;
    createSpy?.mockRestore();
    createSpy = spyOn(memoriesRepository, "create").mockImplementation(
      async () => ({ id: "mem", roomId: ROOM_A }) as never,
    );
  });

  test("same-tenant charge → settlement memory is written into the room", async () => {
    if (!pgliteReady) return;
    await seedCharge(ORG_A, ROOM_A);

    const result = await appChargeCallbacksService.dispatch({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      status: "paid",
      provider: "stripe",
      providerPaymentId: "pi_same",
    });

    expect(result.roomMessageCreated).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [memory] = createSpy.mock.calls[0] as [{ roomId: string; agentId: string }];
    expect(memory.roomId).toBe(ROOM_A);
    expect(memory.agentId).toBe(AGENT_A);
  });

  test("cross-tenant charge → NO memory is written into the victim's room", async () => {
    if (!pgliteReady) return;
    // Attacker org B creates a charge whose channel points at org A's room.
    await seedCharge(ORG_B, ROOM_A);

    const result = await appChargeCallbacksService.dispatch({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      status: "paid",
      provider: "stripe",
      providerPaymentId: "pi_cross",
    });

    expect(result.roomMessageCreated).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("unmapped room → NO memory is written (fail-closed)", async () => {
    if (!pgliteReady) return;
    await seedCharge(ORG_A, UNMAPPED_ROOM);

    const result = await appChargeCallbacksService.dispatch({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      status: "paid",
      provider: "stripe",
      providerPaymentId: "pi_unmapped",
    });

    expect(result.roomMessageCreated).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If pushSchema/PGlite ever fails to init, the DB-dependent tests above
// early-return; this turns that silent no-op into a hard CI failure so a
// money-path proof can never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
