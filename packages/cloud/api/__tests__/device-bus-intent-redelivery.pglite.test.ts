/**
 * A device polls its intent feed without a cursor after a restart, so the route
 * falls back to the 24h lookback. The route records each polled intent in
 * `delivered_to`, which only helps if the poll query also excludes intents the
 * same device already received. Before that, every poll re-delivered the same
 * intents and the device re-executed them.
 */
import { afterAll, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const USER = "22222222-2222-4222-8222-aaaaaaaaaaaa";
const PHONE = "33333333-3333-4333-8333-aaaaaaaaaaaa";
const LAPTOP = "44444444-4444-4444-8444-aaaaaaaaaaaa";
const INTENT = "55555555-5555-4555-8555-aaaaaaaaaaaa";

const realAuth = { ...(await import("@elizaos/cloud-shared/lib/auth")) };
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realAuth,
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: USER, organization_id: ORG },
  }),
}));

const { getPgliteClientForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const client = getPgliteClientForTests();
// Only the columns this route reads or writes; no cross-table fixtures.
await client.exec(`
  CREATE TABLE device_bus_devices (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    push_token text,
    label text,
    online boolean NOT NULL DEFAULT false,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE device_bus_intents (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    delivered_to jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`);
await client.query(
  "INSERT INTO device_bus_devices (id, user_id, platform) VALUES ($1, $2, 'phone'), ($3, $2, 'laptop')",
  [PHONE, USER, LAPTOP],
);
await client.query(
  "INSERT INTO device_bus_intents (id, user_id, kind, payload, delivered_to, created_at) VALUES ($1, $2, 'alarm', '{}'::jsonb, '[]'::jsonb, now() - interval '1 minute')",
  [INTENT, USER],
);

const { Hono } = await import("hono");
const { default: deviceIntentsRoute } = await import(
  "../v1/device-bus/devices/[deviceId]/intents/route"
);

const app = new Hono().route(
  "/api/v1/device-bus/devices/:deviceId/intents",
  deviceIntentsRoute,
);
const poll = (deviceId: string) =>
  app.request(`/api/v1/device-bus/devices/${deviceId}/intents`, {}, {
    NODE_ENV: "test",
    RATE_LIMIT_DISABLED: "true",
  } as never);

test("a device does not receive the same intent twice, other devices still do", async () => {
  const first = (await (await poll(PHONE)).json()) as {
    intents: Array<{ id: string }>;
  };
  expect(first.intents.map((intent) => intent.id)).toEqual([INTENT]);

  const second = (await (await poll(PHONE)).json()) as {
    intents: Array<{ id: string }>;
  };
  expect(second.intents).toEqual([]);

  const otherDevice = (await (await poll(LAPTOP)).json()) as {
    intents: Array<{ id: string }>;
  };
  expect(otherDevice.intents.map((intent) => intent.id)).toEqual([INTENT]);
});

afterAll(async () => {
  await client.close();
});
