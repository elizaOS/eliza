/** A completed /internal/deliver receipt replays instead of crashing on a deserialized value. */

import { expect, test } from "bun:test";
import { deliverInternalMessage } from "../src/internal-delivery";
import { createRedis } from "../src/redis";

process.env.MOCK_REDIS = "1";
process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-key";
process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+14155559999";

test("a complete JSON receipt is replayed without a provider call", async () => {
  const redis = createRedis();
  // GatewayRedis.get JSON-parses stored values (as Upstash does by default),
  // so the receipt reaches parseReceipt as an object, not a string.
  await redis.set(
    "internal-delivery:blooio:eliza-app:reminder-1",
    JSON.stringify({
      state: "complete",
      acceptedAt: "2026-10-06T00:00:00.000Z",
      providerMessageIds: ["msg-1"],
    }),
  );
  const response = await deliverInternalMessage(
    new Request("https://gateway.test/internal/deliver", {
      method: "POST",
      body: JSON.stringify({
        platform: "blooio",
        project: "eliza-app",
        phoneNumber: "+14155550100",
        text: "Reminder: call mom",
        idempotencyKey: "reminder-1",
      }),
    }),
    { redis },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    success: true,
    replayed: true,
    idempotencyKey: "reminder-1",
    acceptedAt: "2026-10-06T00:00:00.000Z",
    providerMessageIds: ["msg-1"],
  });
});
