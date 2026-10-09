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

// Exercise the real Gateway consent projection and provider receipt owner. The
// connector method is controlled locally; no real provider receives a request.
test("canonical STOP, scoped START, replay order and signed compliance retain one consent owner", async () => {
  const { blooioAdapter } = await import("../src/adapters/blooio");
  const { redisNetworkConsentLedger, isNetworkAddressOptedOut } = await import(
    "../src/network-compliance"
  );
  const { readInternalDeliveryReceipt } = await import(
    "../src/internal-delivery"
  );
  const { svcSign } = await import("@elizaos/plugin-network/svc-auth");
  process.env.NETWORK_BLOOIO_API_KEY = "controlled-provider-key";
  process.env.NETWORK_BLOOIO_PHONE_NUMBER = "+14155559998";
  process.env.SERVICE_TURN_SECRET =
    "controlled-service-proof-secret-0123456789";
  const redis = createRedis();
  const ledger = redisNetworkConsentLedger(redis);
  const phone = "+14155550201";
  const stop = {
    project: "network",
    channel: "blooio" as const,
    address: phone,
    state: "opted_out" as const,
    source: "service:stop",
    providerMessageId: "stop-1",
    at: "2026-10-09T12:00:00.000Z",
  };
  await ledger.record(stop);
  await ledger.record({
    ...stop,
    app: "slop",
    state: "opted_in",
    source: "service:start",
    providerMessageId: "start-1",
    at: "2026-10-09T12:00:01.000Z",
  });
  await ledger.record(stop); // canonical replay cannot advance the old STOP.
  expect(await isNetworkAddressOptedOut(ledger, "network", phone)).toBe(true);
  expect(await isNetworkAddressOptedOut(ledger, "network", phone, "slop")).toBe(
    false,
  );
  expect(
    await isNetworkAddressOptedOut(ledger, "network", phone, "friends"),
  ).toBe(true);
  let sends = 0;
  const original = blooioAdapter.sendReplyWithReceipt;
  blooioAdapter.sendReplyWithReceipt = async () => ({
    providerMessageIds: [`controlled-${++sends}`],
  });
  try {
    const payload = {
      platform: "blooio",
      project: "network",
      app: "slop",
      phoneNumber: phone,
      text: "Scoped message",
      idempotencyKey: "network:personal:scoped-test",
    };
    const make = (
      body: object,
      headers?: Record<string, string>,
      path = "/internal/deliver",
    ) =>
      new Request(`https://gateway.test${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const delivered = await deliverInternalMessage(make(payload), { redis });
    expect(delivered.status).toBe(200);
    expect(sends).toBe(1);
    const read = await readInternalDeliveryReceipt(
      make(payload, undefined, "/internal/deliver/receipt"),
      { redis },
    );
    expect(read.status).toBe(200);
    expect(sends).toBe(1);
    expect(
      (
        await deliverInternalMessage(
          make({ ...payload, app: "friends", idempotencyKey: "friend-test" }),
          { redis },
        )
      ).status,
    ).toBe(422);
    expect(sends).toBe(1);
    const compliance = {
      ...payload,
      app: "friends",
      idempotencyKey: "network:personal:stop-ack",
      text: "Stopped",
      networkCompliance: { command: "stop", messageId: "stop-1" },
    };
    expect(
      (await deliverInternalMessage(make(compliance), { redis })).status,
    ).toBe(403);
    const headers = await svcSign(process.env.SERVICE_TURN_SECRET, {
      method: "POST",
      path: "/internal/deliver",
      id: compliance.idempotencyKey,
      body: JSON.stringify(compliance),
    });
    expect(
      (await deliverInternalMessage(make(compliance, headers), { redis }))
        .status,
    ).toBe(200);
    expect(sends).toBe(2);
  } finally {
    blooioAdapter.sendReplyWithReceipt = original;
  }
});
