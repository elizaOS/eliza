/** Applies the BlueBubbles retirement migration to real PGlite and proves targeted fail-closed backfill. */
import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type ConnectedCapabilitySourceRows,
  type PhoneGatewayDeviceRow,
  projectConnectedAccounts,
} from "../../lib/services/connected-capabilities/projection";
import migration from "./0299_retire_legacy_bluebubbles_gateways.sql" with { type: "text" };

const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE phone_gateway_devices (
      id text PRIMARY KEY,
      provider text NOT NULL,
      send_method text,
      is_active boolean NOT NULL DEFAULT true,
      can_send_sms boolean NOT NULL DEFAULT true,
      can_receive_sms boolean NOT NULL DEFAULT true,
      can_send_imessage boolean NOT NULL DEFAULT true,
      can_receive_imessage boolean NOT NULL DEFAULT true,
      friendly_name text,
      phone_account_label text,
      last_seen_at timestamp,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0299 retire legacy BlueBubbles gateways", () => {
  test("deactivates schema-v1 and schema-v2 legacy rows without touching supported gateways", async () => {
    const db = await database();
    await db.exec(`
      INSERT INTO phone_gateway_devices (id, provider, send_method, metadata) VALUES
        ('legacy-v1', 'blooio', 'bluebubbles-local-bridge', '{"schemaVersion":1}'),
        ('legacy-v2', 'blooio', NULL, '{"schemaVersion":2,"gatewayKind":"bluebubbles"}'),
        ('blooio-live', 'blooio', 'blooio-cloud', '{"schemaVersion":2,"gatewayKind":"blooio"}'),
        ('native-live', 'twilio', 'native', '{"schemaVersion":2,"gatewayKind":"native"}')
    `);

    await db.exec(migration);
    const result = await db.query<{
      id: string;
      is_active: boolean;
      can_send_sms: boolean;
      can_receive_sms: boolean;
      can_send_imessage: boolean;
      can_receive_imessage: boolean;
    }>(`
      SELECT id, is_active, can_send_sms, can_receive_sms,
             can_send_imessage, can_receive_imessage
      FROM phone_gateway_devices
      ORDER BY id
    `);

    expect(result.rows).toEqual([
      {
        id: "blooio-live",
        is_active: true,
        can_send_sms: true,
        can_receive_sms: true,
        can_send_imessage: true,
        can_receive_imessage: true,
      },
      {
        id: "legacy-v1",
        is_active: false,
        can_send_sms: false,
        can_receive_sms: false,
        can_send_imessage: false,
        can_receive_imessage: false,
      },
      {
        id: "legacy-v2",
        is_active: false,
        can_send_sms: false,
        can_receive_sms: false,
        can_send_imessage: false,
        can_receive_imessage: false,
      },
      {
        id: "native-live",
        is_active: true,
        can_send_sms: true,
        can_receive_sms: true,
        can_send_imessage: true,
        can_receive_imessage: true,
      },
    ]);

    const projectionRows = await db.query<PhoneGatewayDeviceRow>(`
      SELECT id,
             (
               lower(btrim(coalesce(send_method, ''))) = 'bluebubbles-local-bridge'
               OR lower(btrim(coalesce(metadata ->> 'gatewayKind', ''))) = 'bluebubbles'
             ) AS "isRetiredBlueBubbles",
             is_active, can_send_sms, can_receive_sms,
             can_send_imessage, can_receive_imessage, friendly_name, phone_account_label,
             last_seen_at
      FROM phone_gateway_devices
      ORDER BY id
    `);
    const sourceRows = {
      platformCredentials: [],
      vendorConnections: [],
      discordConnections: [],
      phoneGatewayDevices: projectionRows.rows,
    } satisfies ConnectedCapabilitySourceRows;
    const accounts = await projectConnectedAccounts(sourceRows, new Date("2026-08-22T00:00:00Z"));

    expect(accounts).toHaveLength(2);
    expect(accounts.every((account) => account.status === "connected")).toBe(true);
    expect(
      accounts.every((account) => account.capabilities.every((c) => c.status === "available")),
    ).toBe(true);
  });

  test("is idempotent and matches discriminator case and surrounding whitespace", async () => {
    const db = await database();
    await db.exec(`
      INSERT INTO phone_gateway_devices (id, provider, send_method, metadata) VALUES
        ('legacy-method', 'blooio', '  BlueBubbles-Local-Bridge  ', '{}'),
        ('legacy-kind', 'blooio', NULL, '{"gatewayKind":" BlueBubbles "}')
    `);

    await db.exec(migration);
    await db.exec(migration);
    const result = await db.query<{ active: number; granted: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE is_active)::int AS active,
        COUNT(*) FILTER (
          WHERE can_send_sms OR can_receive_sms OR can_send_imessage OR can_receive_imessage
        )::int AS granted
      FROM phone_gateway_devices
    `);

    expect(result.rows).toEqual([{ active: 0, granted: 0 }]);
  });
});
