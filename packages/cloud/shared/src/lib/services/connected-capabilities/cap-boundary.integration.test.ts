/** Proves retired BlueBubbles history cannot crowd supported gateways out of the production DB loader's fixed row cap. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../../../db/client").closeDatabaseConnectionsForTests
  | undefined;
let connectedCapabilitiesService: typeof import("./index").connectedCapabilitiesService;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../../db/client"));
  ({ connectedCapabilitiesService } = await import("./index"));

  await dbWrite.execute(`
    CREATE TABLE platform_credentials (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      platform text NOT NULL,
      platform_display_name text,
      platform_username text,
      status text NOT NULL,
      scopes text[] NOT NULL DEFAULT '{}',
      last_used_at timestamp,
      deleted_at timestamp,
      created_at timestamp NOT NULL
    )
  `);
  await dbWrite.execute(`
    CREATE TABLE vendor_connections (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      vendor text NOT NULL,
      label text,
      expires_at timestamp,
      scopes text[] NOT NULL DEFAULT '{}',
      deleted_at timestamp,
      refresh_token_encrypted text,
      created_at timestamp NOT NULL
    )
  `);
  await dbWrite.execute(`
    CREATE TABLE discord_connections (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      status text NOT NULL,
      last_heartbeat timestamp,
      created_at timestamp NOT NULL
    )
  `);
  await dbWrite.execute(`
    CREATE TABLE phone_gateway_devices (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      send_method text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      can_send_sms boolean NOT NULL DEFAULT true,
      can_receive_sms boolean NOT NULL DEFAULT true,
      can_send_imessage boolean NOT NULL DEFAULT true,
      can_receive_imessage boolean NOT NULL DEFAULT true,
      friendly_name text,
      phone_account_label text,
      last_seen_at timestamp,
      created_at timestamp NOT NULL
    )
  `);

  await dbWrite.execute(`
    INSERT INTO phone_gateway_devices (
      id,
      organization_id,
      send_method,
      metadata,
      friendly_name,
      created_at
    )
    SELECT
      ('00000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
      '${ORGANIZATION_ID}'::uuid,
      'bluebubbles-local-bridge',
      '{"gatewayKind":"bluebubbles"}'::jsonb,
      'Retired BlueBubbles ' || series,
      '2020-01-01T00:00:00.000Z'::timestamp + series * interval '1 second'
    FROM generate_series(1, 1000) AS series
  `);
  await dbWrite.execute(`
    INSERT INTO phone_gateway_devices (
      id,
      organization_id,
      send_method,
      metadata,
      friendly_name,
      created_at
    ) VALUES
      (
        '22222222-2222-4222-8222-222222222222',
        '${ORGANIZATION_ID}',
        'native-local',
        '{"gatewayKind":"native"}',
        'Supported Native',
        '2021-01-01T00:00:00.000Z'
      ),
      (
        '33333333-3333-4333-8333-333333333333',
        '${ORGANIZATION_ID}',
        'blooio-cloud',
        '{"gatewayKind":"blooio"}',
        'Supported Blooio',
        '2021-01-02T00:00:00.000Z'
      )
  `);
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("connected-capability phone gateway cap boundary", () => {
  test("filters retired BlueBubbles rows before ordering and limiting supported gateways", async () => {
    const page = await connectedCapabilitiesService.list({
      organizationId: ORGANIZATION_ID,
      limit: 10,
      offset: 0,
    });

    expect(page.total).toBe(2);
    expect(page.accounts.map((account) => account.displayName).sort()).toEqual([
      "Supported Blooio",
      "Supported Native",
    ]);
    expect(page.accounts.every((account) => account.status === "connected")).toBe(true);
    expect(
      page.accounts.every((account) =>
        account.capabilities.some((capability) => capability.status === "available"),
      ),
    ).toBe(true);
  });
});
