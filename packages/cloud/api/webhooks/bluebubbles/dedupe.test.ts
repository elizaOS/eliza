/**
 * BlueBubbles webhook replay dedupe (#12227 L5). The local relay retries
 * deliveries; without an event-id dedupe a re-delivered message is routed to
 * the agent twice (duplicate reply + double credit spend). The route now
 * dedupes on `data.guid` via the REAL `webhookEventsRepository.tryCreate`
 * (in-process PGlite). This drives the real route handler twice and pins the
 * second delivery as a no-op.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const routePhoneMessage = mock(async () => ({
  handled: true,
  reason: "delivered",
  replyText: "hi back",
  agentId: "agent-1",
  organizationId: "org-1",
  userId: "user-1",
}));
const registerPhoneGatewayDevice = mock(async () => ({
  id: "dev-1",
  registered: true,
}));

mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: { routePhoneMessage },
}));
mock.module("@/lib/services/phone-gateway-devices", () => ({
  registerPhoneGatewayDevice,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const PGLITE_TIMEOUT = 60_000;
let closeDb: (() => Promise<void>) | undefined;
let bbRoute: typeof import("./route").default;

const SECRET = "bb-secret";
const ENV = { BLUEBUBBLES_GATEWAY_SECRET: SECRET };

function delivery(guid: string) {
  const app = new Hono();
  app.route("/", bbRoute);
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eliza-gateway-secret": SECRET,
      },
      body: JSON.stringify({
        type: "new-message",
        data: {
          guid,
          text: "hello there",
          handle: { address: "+15551234567" },
        },
      }),
    }),
    ENV,
  );
}

beforeAll(async () => {
  const { dbWrite, closeDatabaseConnectionsForTests } = await import(
    "@/db/client"
  );
  closeDb = closeDatabaseConnectionsForTests;
  await dbWrite.execute(
    `CREATE TABLE IF NOT EXISTS webhook_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id text NOT NULL UNIQUE,
      provider text NOT NULL,
      event_type text,
      payload_hash text NOT NULL,
      source_ip text,
      processed_at timestamp NOT NULL DEFAULT now(),
      event_timestamp timestamp
    );`,
  );
  ({ default: bbRoute } = await import("./route"));
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("BlueBubbles webhook — replay dedupe (L5)", () => {
  beforeEach(async () => {
    routePhoneMessage.mockClear();
    registerPhoneGatewayDevice.mockClear();
    const { dbWrite } = await import("@/db/client");
    await dbWrite.execute("DELETE FROM webhook_events;");
  });

  test("first delivery routes; a replay of the same guid is a no-op", async () => {
    const first = await delivery("guid-abc-1");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ success: true });
    expect(routePhoneMessage).toHaveBeenCalledTimes(1);

    const replay = await delivery("guid-abc-1");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      skipped: "duplicate_delivery",
    });
    // The agent must NOT be re-invoked on the replay.
    expect(routePhoneMessage).toHaveBeenCalledTimes(1);
  });

  test("a distinct guid is routed normally", async () => {
    await delivery("guid-abc-1");
    const other = await delivery("guid-xyz-2");
    expect(other.status).toBe(200);
    expect(routePhoneMessage).toHaveBeenCalledTimes(2);
  });
});
