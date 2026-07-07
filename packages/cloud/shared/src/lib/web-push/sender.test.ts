// Web Push sender — proves the correct headers/body are POSTed, 2xx = ok, and
// 404/410 = gone (prune), other statuses = keep, network error = keep.
import { describe, expect, test, vi } from "vitest";
import { bytesToBase64Url } from "./base64url";
import {
  isGoneStatus,
  type StoredPushSubscription,
  sendWebPush,
  sendWebPushBatch,
  type WebPushVapidConfig,
} from "./sender";

async function makeVapid(): Promise<WebPushVapidConfig> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: bytesToBase64Url(rawPub),
    privateKey: jwk.d as string,
    subject: "mailto:x@y.z",
  };
}

async function makeSubscription(
  endpoint = "https://push.example.com/abc",
): Promise<StoredPushSubscription> {
  const uaPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", uaPair.publicKey));
  return {
    endpoint,
    keys: {
      p256dh: bytesToBase64Url(uaPublicRaw),
      auth: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

describe("isGoneStatus", () => {
  test("true for 404 and 410 only", () => {
    expect(isGoneStatus(404)).toBe(true);
    expect(isGoneStatus(410)).toBe(true);
    expect(isGoneStatus(201)).toBe(false);
    expect(isGoneStatus(500)).toBe(false);
    expect(isGoneStatus(429)).toBe(false);
  });
});

describe("sendWebPush", () => {
  test("POSTs with VAPID auth + aes128gcm headers and returns ok on 201", async () => {
    const vapid = await makeVapid();
    const sub = await makeSubscription();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));

    const outcome = await sendWebPush(sub, { title: "T", body: "B" }, vapid, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ ok: true, status: 201 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(sub.endpoint);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(init.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(init.headers.TTL).toBe(String(60 * 60 * 24));
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect((init.body as Uint8Array).length).toBeGreaterThan(86);
  });

  test("410 Gone ⇒ gone:true (prune)", async () => {
    const vapid = await makeVapid();
    const sub = await makeSubscription();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }));
    const outcome = await sendWebPush(sub, { title: "T", body: "B" }, vapid, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, gone: true, status: 410 });
  });

  test("404 ⇒ gone:true (prune)", async () => {
    const vapid = await makeVapid();
    const sub = await makeSubscription();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const outcome = await sendWebPush(sub, { title: "T", body: "B" }, vapid, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ gone: true, status: 404 });
  });

  test("500 ⇒ keep (gone:false)", async () => {
    const vapid = await makeVapid();
    const sub = await makeSubscription();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const outcome = await sendWebPush(sub, { title: "T", body: "B" }, vapid, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ ok: false, gone: false, status: 500 });
  });

  test("network throw ⇒ keep (gone:false, status 0)", async () => {
    const vapid = await makeVapid();
    const sub = await makeSubscription();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const outcome = await sendWebPush(sub, { title: "T", body: "B" }, vapid, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ ok: false, gone: false, status: 0 });
  });

  test("malformed endpoint ⇒ gone:true without a fetch", async () => {
    const vapid = await makeVapid();
    const sub = await makeSubscription("not-a-url");
    const fetchImpl = vi.fn();
    const outcome = await sendWebPush(sub, { title: "T", body: "B" }, vapid, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ ok: false, gone: true, status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sendWebPushBatch", () => {
  test("collects goneEndpoints for pruning and counts sent/failed", async () => {
    const vapid = await makeVapid();
    const good = await makeSubscription("https://push.example.com/good");
    const gone = await makeSubscription("https://push.example.com/gone");
    const err = await makeSubscription("https://push.example.com/err");

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/good")) return new Response(null, { status: 201 });
      if (url.endsWith("/gone")) return new Response(null, { status: 410 });
      return new Response(null, { status: 500 });
    });

    const result = await sendWebPushBatch([good, gone, err], { title: "T", body: "B" }, vapid, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.goneEndpoints).toEqual(["https://push.example.com/gone"]);
  });
});
