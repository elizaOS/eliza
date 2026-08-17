/** Verifies Workerd APNs configuration, ES256 request shaping, and typed provider outcomes. */

import { describe, expect, test } from "vitest";
import { CloudApnsProvider, ELIZA_IOS_BUNDLE_ID, resolveCloudApnsConfig } from "./apns-provider";

async function fixture(production = false) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const encoded =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  const config = resolveCloudApnsConfig({
    ELIZA_APNS_KEY: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
    ELIZA_APNS_KEY_ID: "KEY123",
    ELIZA_APNS_TEAM_ID: "TEAM123",
    ELIZA_APNS_TOPIC: ELIZA_IOS_BUNDLE_ID,
    ELIZA_APNS_PRODUCTION: production ? "1" : "0",
  });
  if (!config) throw new Error("fixture APNs config did not resolve");
  return { config, publicKey };
}

describe("CloudApnsProvider", () => {
  test("is absent only when every APNs binding is absent", () => {
    expect(resolveCloudApnsConfig({})).toBeNull();
    expect(() => resolveCloudApnsConfig({ ELIZA_APNS_KEY_ID: "partial" })).toThrow("incomplete");
  });

  test("fails closed on topic and environment disagreement", async () => {
    const { config } = await fixture();
    expect(() =>
      resolveCloudApnsConfig({
        ...config,
        ELIZA_APNS_KEY: config.key,
        ELIZA_APNS_KEY_ID: config.keyId,
        ELIZA_APNS_TEAM_ID: config.teamId,
        ELIZA_APNS_TOPIC: "wrong.bundle",
        ELIZA_APNS_PRODUCTION: "0",
      }),
    ).toThrow(ELIZA_IOS_BUNDLE_ID);
    expect(() =>
      resolveCloudApnsConfig({
        ELIZA_APNS_KEY: config.key,
        ELIZA_APNS_KEY_ID: config.keyId,
        ELIZA_APNS_TEAM_ID: config.teamId,
        ELIZA_APNS_TOPIC: ELIZA_IOS_BUNDLE_ID,
        ELIZA_APNS_PRODUCTION: "true",
      }),
    ).toThrow('explicitly "0" or "1"');
  });

  test("sends a sandbox alert with a verifiable provider token", async () => {
    const { config, publicKey } = await fixture();
    let captured: { url: string; init: RequestInit } | undefined;
    const provider = new CloudApnsProvider(config, async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(null, { status: 200, headers: { "apns-id": "accepted-id" } });
    });
    await expect(
      provider.send("device-token", { title: "Ready", body: "Open Eliza" }, 1_800_000_000_000),
    ).resolves.toEqual({ outcome: "accepted", apnsId: "accepted-id" });
    expect(captured?.url).toBe("https://api.sandbox.push.apple.com/3/device/device-token");
    expect(new Headers(captured?.init.headers).get("apns-topic")).toBe(ELIZA_IOS_BUNDLE_ID);
    const jwt = new Headers(captured?.init.headers).get("authorization")?.replace("bearer ", "");
    if (!jwt) throw new Error("authorization token was not sent");
    const [header, payload, signature] = jwt.split(".");
    const decode = (value: string) =>
      JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(decode(payload)).toMatchObject({ iss: "TEAM123", iat: 1_800_000_000 });
    const padded = signature
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(signature.length / 4) * 4, "=");
    const signatureBytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signatureBytes,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).resolves.toBe(true);
  });

  test.each(["Unregistered", "BadDeviceToken"] as const)(
    "classifies %s as durable-token cleanup",
    async (reason) => {
      const { config } = await fixture(true);
      const provider = new CloudApnsProvider(config, async () =>
        Response.json({ reason }, { status: reason === "Unregistered" ? 410 : 400 }),
      );
      await expect(provider.send("dead", { title: "x" })).resolves.toEqual({
        outcome: "unregistered",
        reason,
      });
    },
  );

  test("preserves non-token rejection status and reason", async () => {
    const { config } = await fixture();
    const provider = new CloudApnsProvider(config, async () =>
      Response.json({ reason: "TooManyRequests" }, { status: 429 }),
    );
    await expect(provider.send("live", { title: "x" })).resolves.toEqual({
      outcome: "rejected",
      status: 429,
      reason: "TooManyRequests",
    });
  });
});
