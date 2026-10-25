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
for (const project of ["network", "eliza-app"])
  test(`canonical STOP, scoped START, replay order and signed compliance retain one consent owner on ${project}`, async () => {
    const { blooioAdapter } = await import("../src/adapters/blooio");
    const { redisNetworkConsentLedger, isNetworkAddressOptedOut } =
      await import("../src/network-compliance");
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
    const phone = project === "network" ? "+14155550201" : "+14155550202";
    process.env.NETWORK_TAKEOVER = "1";
    process.env.NETWORK_SHARED_PROJECT = "eliza-app";
    process.env.NETWORK_TAKEOVER_ALLOWLIST = phone;
    process.env.ELIZA_APP_BLOOIO_API_KEY = "controlled-provider-key";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+14155559999";
    const stop = {
      project,
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
    expect(await isNetworkAddressOptedOut(ledger, project, phone)).toBe(true);
    expect(await isNetworkAddressOptedOut(ledger, project, phone, "slop")).toBe(
      false,
    );
    expect(
      await isNetworkAddressOptedOut(ledger, project, phone, "friends"),
    ).toBe(true);
    let sends = 0;
    const original = blooioAdapter.sendReplyWithReceipt;
    blooioAdapter.sendReplyWithReceipt = async () => ({
      providerMessageIds: [`controlled-${++sends}`],
    });
    try {
      const payload = {
        platform: "blooio",
        project,
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

test("abandoned recovery survives an expired delayed dispatch claim", async () => {
  const { readInternalDeliveryReceipt } = await import(
    "../src/internal-delivery"
  );
  const { blooioAdapter } = await import("../src/adapters/blooio");
  const redis = createRedis();
  const payload = {
    platform: "blooio",
    project: "eliza-app",
    phoneNumber: "+14155550100",
    text: "Controlled recovery fixture",
    idempotencyKey: "recovery-expired-claim",
  };
  const request = (abandon = false) =>
    new Request("https://gateway.test/internal/deliver", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        ...(abandon ? { abandonUnclaimed: true } : {}),
      }),
    });
  const original = blooioAdapter.sendReplyWithReceipt;
  let sends = 0;
  blooioAdapter.sendReplyWithReceipt = async () => ({
    providerMessageIds: [`fixture-${++sends}`],
  });
  const originalEval = redis.eval.bind(redis);
  redis.eval = async (script, keys, args) => {
    if (script.includes('redis.call("set"')) {
      // Simulate Redis expiring the 60-second claim while the dispatch command is delayed.
      await redis.del(keys[0]);
      expect(
        (await readInternalDeliveryReceipt(request(true), { redis })).status,
      ).toBe(422);
    }
    return originalEval(script, keys, args);
  };
  try {
    expect(
      (await readInternalDeliveryReceipt(request(), { redis })).status,
    ).toBe(202);
    expect((await deliverInternalMessage(request(), { redis })).status).toBe(
      202,
    );
    expect(
      (await readInternalDeliveryReceipt(request(true), { redis })).status,
    ).toBe(422);
    expect((await deliverInternalMessage(request(), { redis })).status).toBe(
      422,
    );
    expect(sends).toBe(0);
  } finally {
    blooioAdapter.sendReplyWithReceipt = original;
  }
});

test("a Shared STOP that lands after admission still prevents provider dispatch", async () => {
  const { blooioAdapter } = await import("../src/adapters/blooio");
  const { redisNetworkConsentLedger } = await import(
    "../src/network-compliance"
  );
  const phone = "+14155550203";
  process.env.NETWORK_TAKEOVER = "1";
  process.env.NETWORK_SHARED_PROJECT = "eliza-app";
  process.env.NETWORK_TAKEOVER_ALLOWLIST = phone;
  const redis = createRedis();
  if (!redis.eval) throw new Error("Expected atomic Redis adapter");
  const evalOriginal = redis.eval.bind(redis);
  redis.eval = async (script, keys, args) => {
    if (script.includes('redis.call("set"'))
      await redisNetworkConsentLedger(redis).record({
        project: "eliza-app",
        channel: "blooio",
        address: phone,
        state: "opted_out",
        source: "service:stop",
        at: new Date().toISOString(),
      });
    return evalOriginal(script, keys, args);
  };
  const original = blooioAdapter.sendReplyWithReceipt;
  let sends = 0;
  blooioAdapter.sendReplyWithReceipt = async () => ({
    providerMessageIds: [`unexpected-${++sends}`],
  });
  try {
    const response = await deliverInternalMessage(
      new Request("https://gateway.test/internal/deliver", {
        method: "POST",
        body: JSON.stringify({
          platform: "blooio",
          project: "eliza-app",
          phoneNumber: phone,
          text: "must not send",
          idempotencyKey: "mid-dispatch-stop",
        }),
      }),
      { redis },
    );
    expect(response.status).toBe(422);
    expect(sends).toBe(0);
    expect(
      await redis.get("internal-delivery:blooio:eliza-app:mid-dispatch-stop"),
    ).toBeNull();
  } finally {
    blooioAdapter.sendReplyWithReceipt = original;
  }
});

test("receipt identity binds the original connector account and forum thread without resending", async () => {
  const { telegramAdapter } = await import("../src/adapters/telegram");
  const {
    configureTelegramIdentity,
    withTelegramIdentity,
    TELEGRAM_CONNECTOR_ACCOUNT_ID,
  } = await import("./telegram-identity-fixture");
  const { readInternalDeliveryReceipt } = await import(
    "../src/internal-delivery"
  );
  configureTelegramIdentity();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withTelegramIdentity(async () => {
    throw new Error("Unexpected provider call");
  });
  const original = telegramAdapter.sendReplyWithReceipt;
  let sends = 0;
  telegramAdapter.sendReplyWithReceipt = async () => ({
    providerMessageIds: [`thread-receipt-${++sends}`],
  });
  const redis = createRedis();
  const payload = {
    platform: "telegram",
    project: "eliza-app",
    connectorAccountId: TELEGRAM_CONNECTOR_ACCOUNT_ID,
    chatId: "-100555501",
    providerThreadId: "1",
    text: "Thread reminder",
    idempotencyKey: "thread-target-test",
  };
  const request = (body: object, path = "/internal/deliver") =>
    new Request(`https://gateway.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  try {
    expect(
      (await deliverInternalMessage(request(payload), { redis })).status,
    ).toBe(200);
    expect(
      (
        await readInternalDeliveryReceipt(
          request(payload, "/internal/deliver/receipt"),
          { redis },
        )
      ).status,
    ).toBe(200);
    const otherThread = { ...payload, providerThreadId: "2" };
    expect(
      (
        await readInternalDeliveryReceipt(
          request(otherThread, "/internal/deliver/receipt"),
          { redis },
        )
      ).status,
    ).toBe(202);
    expect(
      (await deliverInternalMessage(request(otherThread), { redis })).status,
    ).toBe(409);
    const otherConnector = { ...payload, connectorAccountId: "bot:other" };
    expect(
      (
        await readInternalDeliveryReceipt(
          request(otherConnector, "/internal/deliver/receipt"),
          { redis },
        )
      ).status,
    ).toBe(202);
    expect(
      (await deliverInternalMessage(request(otherConnector), { redis })).status,
    ).not.toBe(200);
    expect(sends).toBe(1);
  } finally {
    telegramAdapter.sendReplyWithReceipt = original;
    globalThis.fetch = originalFetch;
  }
});

test("unhashed legacy Network acceptance stays unknown for direct and receipt-only replay", async () => {
  const { readInternalDeliveryReceipt } = await import(
    "../src/internal-delivery"
  );
  const { blooioAdapter } = await import("../src/adapters/blooio");
  const original = blooioAdapter.sendReplyWithReceipt;
  let sends = 0;
  blooioAdapter.sendReplyWithReceipt = async () => {
    sends++;
    throw new Error("must not send");
  };
  try {
    for (const idempotencyKey of [
      "network:personal:legacy-1",
      "network:handled:legacy-1",
    ]) {
      const redis = createRedis();
      const payload = {
        platform: "blooio",
        project: "eliza-app",
        phoneNumber: "+14155550100",
        text: "Original",
        idempotencyKey,
      };
      await redis.set(
        `internal-delivery:blooio:eliza-app:${idempotencyKey}`,
        JSON.stringify({
          state: "complete",
          acceptedAt: "2026-10-06T00:00:00.000Z",
          providerMessageIds: ["legacy-receipt"],
        }),
      );
      for (const body of [
        payload,
        { ...payload, phoneNumber: "+14155550101" },
        { ...payload, text: "Changed" },
      ]) {
        for (const deliver of [
          deliverInternalMessage,
          readInternalDeliveryReceipt,
        ]) {
          const response = await deliver(
            new Request("https://gateway.test/internal/deliver", {
              method: "POST",
              body: JSON.stringify(body),
            }),
            { redis },
          );
          expect(response.status).toBe(202);
          expect(await response.json()).toMatchObject({
            success: false,
            acceptance: "unknown",
            retryable: false,
          });
        }
      }
    }
    expect(sends).toBe(0);
  } finally {
    blooioAdapter.sendReplyWithReceipt = original;
  }
});

test("a receipt without connector and thread binding stays unknown and never resends", async () => {
  const { readInternalDeliveryReceipt } = await import(
    "../src/internal-delivery"
  );
  const redis = createRedis();
  const payload = {
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: "blooio:+14155559999",
    phoneNumber: "+14155550100",
    text: "Reminder: call mom",
    idempotencyKey: "reminder-before-binding",
  };
  // The receipt hash the gateway wrote until 2026-10-12: no connector account
  // or thread slot. Such receipts live for the full receipt TTL after a deploy.
  const hashedBeforeBinding = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            payload.platform,
            payload.project,
            null,
            payload.phoneNumber,
            payload.text,
            payload.idempotencyKey,
          ]),
        ),
      ),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const request = (body: object, path = "/internal/deliver") =>
    new Request(`https://gateway.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const key = `internal-delivery:blooio:eliza-app:${payload.idempotencyKey}`;
  await redis.set(
    key,
    JSON.stringify({
      state: "complete",
      hash: hashedBeforeBinding,
      acceptedAt: "2026-10-12T00:00:00.000Z",
      providerMessageIds: ["msg-before-binding"],
    }),
  );
  const replay = await deliverInternalMessage(request(payload), { redis });
  expect(replay.status).toBe(202);
  expect(await replay.json()).toMatchObject({
    acceptance: "unknown",
    retryable: false,
  });
  const receipt = await readInternalDeliveryReceipt(
    request(payload, "/internal/deliver/receipt"),
    { redis },
  );
  expect(receipt.status).toBe(202);
  const changedConnector = {
    ...payload,
    connectorAccountId: "blooio:+14155558888",
  };
  const redirected = await deliverInternalMessage(request(changedConnector), {
    redis,
  });
  expect(redirected.status).toBe(202);
  expect(await redirected.json()).toMatchObject({
    acceptance: "unknown",
    retryable: false,
  });
  expect(
    (
      await readInternalDeliveryReceipt(
        request(changedConnector, "/internal/deliver/receipt"),
        { redis },
      )
    ).status,
  ).toBe(202);
  // A different message under the same key is still a conflict.
  const otherText = { ...payload, text: "Reminder: call dad" };
  expect(
    (await deliverInternalMessage(request(otherText), { redis })).status,
  ).toBe(409);
  expect(
    (
      await readInternalDeliveryReceipt(
        request(otherText, "/internal/deliver/receipt"),
        { redis },
      )
    ).status,
  ).toBe(202);
  // An unsettled dispatch from before the deploy stays indeterminate.
  await redis.set(
    key,
    JSON.stringify({ state: "indeterminate", hash: hashedBeforeBinding }),
  );
  const pending = await deliverInternalMessage(request(payload), { redis });
  expect(pending.status).toBe(202);
  expect(await pending.json()).toMatchObject({ acceptance: "unknown" });
});
