/** Real delivery/adapter/receipt paths; only HTTP and Redis transport are controlled. No real photos. */
import { afterEach, expect, test } from "bun:test";
import type { ApprovedRelayPhoto } from "@elizaos/plugin-network/contract";
import { svcSign } from "@elizaos/plugin-network/svc-auth";
import {
  deliverInternalMessage,
  readInternalDeliveryReceipt,
} from "../src/internal-delivery";
import { createRedis } from "../src/redis";

const originalFetch = globalThis.fetch;
const keys = [
  "MOCK_REDIS",
  "NETWORK_RELAY_ENABLED",
  "NETWORK_SERVICE_URL",
  "SERVICE_TURN_SECRET",
  "NETWORK_TAKEOVER",
  "NETWORK_TAKEOVER_ALLOWLIST",
  "NETWORK_SHARED_PROJECT",
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
];
const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    const value = before[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const secret = "controlled-photo-gateway-service-".repeat(3);
const to = "+15555550101";
function fixture() {
  Object.assign(process.env, {
    MOCK_REDIS: "1",
    NETWORK_RELAY_ENABLED: "1",
    NETWORK_SERVICE_URL: "https://backend.invalid",
    SERVICE_TURN_SECRET: secret,
    NETWORK_TAKEOVER: "1",
    NETWORK_TAKEOVER_ALLOWLIST: to,
    NETWORK_SHARED_PROJECT: "eliza-app",
    ELIZA_APP_BLOOIO_API_KEY: "synthetic-no-real-key",
    ELIZA_APP_BLOOIO_PHONE_NUMBER: "+15555550202",
  });
  const now = Date.now();
  const photo: ApprovedRelayPhoto = {
    version: 1,
    app: "slop",
    itemId: "pri_" + "a".repeat(32),
    threadId: "thread-1",
    senderMemberId: "sender",
    recipientMemberId: "recipient",
    photoId: "ph_" + "a".repeat(24),
    sha256: "a".repeat(64),
    bytes: 100,
    contentType: "image/jpeg",
    consentId: "consent-1",
    consentedAt: now - 1000,
    reviewId: "review-1",
    reviewedAt: now - 500,
    policyVersion: "controlled-closed-policy",
    expiresAt: now + 60000,
  };
  const capability = `https://backend.invalid/api/relay-photos/deliver/${photo.itemId}?exp=${now + 30000}&sig=${"a".repeat(43)}`;
  const redis = createRedis();
  const dependencies = {
    redis,
    networkConsentLedger: { current: async () => null, record: async () => {} },
  };
  const body = {
    platform: "blooio",
    project: "eliza-app",
    app: "slop",
    phoneNumber: to,
    text: "Ari sent you a photo.",
    idempotencyKey: `network:personal:photo-${crypto.randomUUID()}`,
    approvedPhotos: [photo],
  };
  const request = async (receipt = false, patch = {}) => {
    const path = receipt ? "/internal/deliver/receipt" : "/internal/deliver";
    const wire = JSON.stringify({ ...body, ...patch });
    return new Request("https://gateway.invalid" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await svcSign(secret, {
          method: "POST",
          path,
          id: body.idempotencyKey,
          body: wire,
        })),
      },
      body: wire,
    });
  };
  return { photo, capability, redis, dependencies, body, request };
}
const fetchFixture = (
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch =>
  Object.assign(fn, {
    preconnect() {
      throw new Error("No fixture preconnect");
    },
  });

test("approved item uses durable claim then provider media once; replay/receipt never resolves new URLs", async () => {
  const f = fixture();
  let resolves = 0,
    sends = 0;
  globalThis.fetch = fetchFixture(async (url, init) => {
    const state = await f.redis.get(
      "internal-delivery:blooio:eliza-app:" + f.body.idempotencyKey,
    );
    if (
      String(url) === "https://backend.invalid/internal/relay-photo/resolve"
    ) {
      resolves++;
      expect(String(state).startsWith("pending:")).toBe(true);
      return Response.json({
        photos: [
          {
            photoId: f.photo.photoId,
            sha256: f.photo.sha256,
            bytes: f.photo.bytes,
            contentType: f.photo.contentType,
            url: f.capability,
          },
        ],
      });
    }
    expect(String(url)).toBe("https://api.blooio.com/v4/messages");
    sends++;
    expect(typeof state === "string" ? JSON.parse(state) : state).toMatchObject(
      { state: "indeterminate" },
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      to,
      text: f.body.text,
      attachments: [f.capability],
    });
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
      "gw-reply-" + f.body.idempotencyKey,
    );
    return Response.json({ id: "controlled-provider-photo-id" });
  });
  expect(
    (await deliverInternalMessage(await f.request(), f.dependencies)).status,
  ).toBe(200);
  process.env.NETWORK_RELAY_ENABLED = "0";
  expect(
    (await deliverInternalMessage(await f.request(), f.dependencies)).status,
  ).toBe(200);
  expect(
    (await readInternalDeliveryReceipt(await f.request(true), f.dependencies))
      .status,
  ).toBe(200);
  expect(
    (
      await deliverInternalMessage(
        await f.request(false, {
          approvedPhotos: [{ ...f.photo, sha256: "b".repeat(64) }],
        }),
        f.dependencies,
      )
    ).status,
  ).toBe(409);
  expect([resolves, sends]).toEqual([1, 1]);
});

test("lost provider acceptance stays unknown without resolving or sending again", async () => {
  const f = fixture();
  let resolves = 0,
    sends = 0;
  globalThis.fetch = fetchFixture(async (url) => {
    if (
      String(url) === "https://backend.invalid/internal/relay-photo/resolve"
    ) {
      resolves++;
      return Response.json({
        photos: [
          {
            photoId: f.photo.photoId,
            sha256: f.photo.sha256,
            bytes: f.photo.bytes,
            contentType: f.photo.contentType,
            url: f.capability,
          },
        ],
      });
    }
    expect(String(url)).toBe("https://api.blooio.com/v4/messages");
    sends++;
    throw new TypeError("controlled response lost after acceptance");
  });
  expect(
    (await deliverInternalMessage(await f.request(), f.dependencies)).status,
  ).toBe(202);
  process.env.NETWORK_RELAY_ENABLED = "0";
  expect(
    (await deliverInternalMessage(await f.request(), f.dependencies)).status,
  ).toBe(202);
  expect(
    (await readInternalDeliveryReceipt(await f.request(true), f.dependencies))
      .status,
  ).toBe(202);
  expect([resolves, sends]).toEqual([1, 1]);
});

test("forged signature and rejected item resolution make no provider call", async () => {
  const f = fixture();
  let calls = 0;
  globalThis.fetch = fetchFixture(async (url) => {
    expect(String(url)).toBe(
      "https://backend.invalid/internal/relay-photo/resolve",
    );
    calls++;
    return new Response(null, { status: 403 });
  });
  const forged = await f.request();
  forged.headers.delete("x-ntwrk-svc-sig");
  expect((await deliverInternalMessage(forged, f.dependencies)).status).toBe(
    403,
  );
  expect(calls).toBe(0);
  expect(
    (await deliverInternalMessage(await f.request(), f.dependencies)).status,
  ).toBe(502);
  expect(calls).toBe(1);
});

test("supplied route authority is rejected before Redis claims, resolution or provider work", async () => {
  const f = fixture();
  let calls = 0;
  globalThis.fetch = fetchFixture(async () => {
    calls++;
    throw Error("must not resolve or send");
  });
  for (const authority of [
    null,
    "untrusted",
    {
      version: 1,
      routeId: "isolated",
      generation: "g1",
      audience: "qa",
      realmId: "closed",
    },
  ]) {
    const request = await f.request(false, { networkAuthority: authority });
    expect((await deliverInternalMessage(request, f.dependencies)).status).toBe(
      400,
    );
  }
  expect(
    await f.redis.get(
      `internal-delivery:blooio:eliza-app:${f.body.idempotencyKey}`,
    ),
  ).toBeNull();
  expect(calls).toBe(0);
});
