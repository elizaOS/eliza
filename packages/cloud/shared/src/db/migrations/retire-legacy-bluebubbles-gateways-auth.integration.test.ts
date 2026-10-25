/** Proves the real gateway authentication service rejects rows retired by the BlueBubbles migration. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const BRIDGE_ID = "bb-retired-auth";
const TOKEN = `bbg_${"a".repeat(64)}`;

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../../db/client").closeDatabaseConnectionsForTests
  | undefined;
let authenticateBlueBubblesGateway: typeof import("../../lib/services/phone-gateway-devices").authenticateBlueBubblesGateway;
let hashBlueBubblesGatewayToken: typeof import("../../lib/services/phone-gateway-devices").hashBlueBubblesGatewayToken;
let listBlueBubblesGateways: typeof import("../../lib/services/phone-gateway-devices").listBlueBubblesGateways;
let revokeBlueBubblesGateway: typeof import("../../lib/services/phone-gateway-devices").revokeBlueBubblesGateway;

const migration = await readFile(
  new URL("./0309_retire_legacy_bluebubbles_gateways.sql", import.meta.url),
  "utf8",
);

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../db/client"));
  ({
    authenticateBlueBubblesGateway,
    hashBlueBubblesGatewayToken,
    listBlueBubblesGateways,
    revokeBlueBubblesGateway,
  } = await import("../../lib/services/phone-gateway-devices"));

  await dbWrite.execute(
    "CREATE TYPE phone_provider AS ENUM ('twilio', 'blooio', 'vonage', 'whatsapp', 'other')",
  );
  await dbWrite.execute(`
    CREATE TABLE phone_gateway_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      provider phone_provider NOT NULL,
      phone_number text NOT NULL,
      bridge_id text NOT NULL DEFAULT 'default',
      phone_account_id text,
      phone_account_label text,
      friendly_name text,
      send_method text,
      cloud_webhook_url text,
      local_webhook_url text,
      is_active boolean NOT NULL DEFAULT true,
      can_send_sms boolean NOT NULL DEFAULT true,
      can_receive_sms boolean NOT NULL DEFAULT true,
      can_send_imessage boolean NOT NULL DEFAULT true,
      can_receive_imessage boolean NOT NULL DEFAULT true,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      last_seen_at timestamp
    );
  `);

  const authTokenHash = await hashBlueBubblesGatewayToken(TOKEN);
  await dbWrite.execute(`
    INSERT INTO phone_gateway_devices (
      id, organization_id, provider, phone_number, bridge_id, send_method, metadata
    ) VALUES (
      '${GATEWAY_ID}',
      '${ORGANIZATION_ID}',
      'blooio',
      '+14155550123',
      '${BRIDGE_ID}',
      'bluebubbles-local-bridge',
      '{
        "schemaVersion": 2,
        "gatewayKind": "bluebubbles",
        "ownerUserId": "${USER_ID}",
        "routingMode": "sender-owned",
        "agentId": null,
        "authTokenHash": "${authTokenHash}",
        "tokenCreatedAt": "2026-08-22T00:00:00.000Z"
      }'::jsonb
    );
  `);
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("0309 retired gateway authentication boundary", () => {
  test("authenticates before retirement, then denies auth, listing, and revocation after migration", async () => {
    await expect(authenticateBlueBubblesGateway(BRIDGE_ID, TOKEN)).resolves.toMatchObject({
      id: GATEWAY_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    });
    await expect(listBlueBubblesGateways(ORGANIZATION_ID, USER_ID)).resolves.toHaveLength(1);

    await dbWrite.execute(migration);

    await expect(authenticateBlueBubblesGateway(BRIDGE_ID, TOKEN)).resolves.toBeNull();
    await expect(listBlueBubblesGateways(ORGANIZATION_ID, USER_ID)).resolves.toEqual([]);
    await expect(revokeBlueBubblesGateway(ORGANIZATION_ID, USER_ID, GATEWAY_ID)).resolves.toBe(
      false,
    );

    const result = await dbWrite.execute(`
      SELECT is_active, can_send_sms, can_receive_sms, can_send_imessage, can_receive_imessage
      FROM phone_gateway_devices
      WHERE id = '${GATEWAY_ID}'
    `);
    expect(result.rows).toEqual([
      {
        is_active: false,
        can_send_sms: false,
        can_receive_sms: false,
        can_send_imessage: false,
        can_receive_imessage: false,
      },
    ]);
  });
});
