/**
 * Exercises signed Discord application event webhooks and real REST request
 * shapes with deterministic cryptographic and network fixtures.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  createDiscordPublicKeyResolver,
  handleDiscordEventWebhook,
  verifyDiscordEventSignature,
} from "../src/discord-event-webhook";

const APPLICATION_ID = "1474591626759376967";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const rawPublicKey = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

function signedRequest(payload: unknown, valid = true): Request {
  const body = JSON.stringify(payload);
  const timestamp = "2026-08-14T09:00:00.000000";
  const signature = sign(
    null,
    Buffer.from(`${timestamp}${body}`),
    privateKey,
  ).toString("hex");
  return new Request("https://gateway.example/discord/event-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": valid ? signature : "00".repeat(64),
      "x-signature-timestamp": timestamp,
    },
    body,
  });
}

describe("Discord application event webhook", () => {
  test("verifies Ed25519 signatures and rejects invalid requests", async () => {
    const body = JSON.stringify({ type: 0 });
    const timestamp = "123";
    const signature = sign(
      null,
      Buffer.from(`${timestamp}${body}`),
      privateKey,
    ).toString("hex");
    expect(
      verifyDiscordEventSignature(body, timestamp, signature, rawPublicKey),
    ).toBe(true);
    expect(
      verifyDiscordEventSignature(
        body,
        timestamp,
        "00".repeat(64),
        rawPublicKey,
      ),
    ).toBe(false);

    const response = await handleDiscordEventWebhook(
      signedRequest({ type: 0 }, false),
      {
        applicationId: APPLICATION_ID,
        botToken: "token",
        getPublicKey: async () => rawPublicKey,
      },
    );
    expect(response.status).toBe(401);
  });

  test("acknowledges Discord endpoint validation pings", async () => {
    const response = await handleDiscordEventWebhook(
      signedRequest({ application_id: APPLICATION_ID, type: 0 }),
      {
        applicationId: APPLICATION_ID,
        botToken: "token",
        getPublicKey: async () => rawPublicKey,
      },
    );
    expect(response.status).toBe(204);
  });

  test("opens a DM and sends one welcome for user installs", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json(
        url.endsWith("/users/@me/channels")
          ? { id: "dm-channel" }
          : { id: "message" },
      );
    };
    const response = await handleDiscordEventWebhook(
      signedRequest({
        version: 1,
        application_id: APPLICATION_ID,
        type: 1,
        event: {
          type: "APPLICATION_AUTHORIZED",
          timestamp: "2026-08-14T09:00:00.000000",
          data: {
            integration_type: 1,
            scopes: ["applications.commands"],
            user: { id: "498273781589213185", global_name: "shaw" },
          },
        },
      }),
      {
        applicationId: APPLICATION_ID,
        botToken: "token",
        getPublicKey: async () => rawPublicKey,
        fetchImpl,
      },
    );
    expect(response.status).toBe(204);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual({ recipient_id: "498273781589213185" });
    expect(calls[1]?.url).toEndWith("/channels/dm-channel/messages");
    expect(calls[1]?.body.content).toContain("Hey shaw");
    expect(calls[1]?.body.enforce_nonce).toBe(true);
    expect(String(calls[1]?.body.nonce)).toMatch(/^\d+$/);
  });

  test("ignores guild installs", async () => {
    let called = false;
    const response = await handleDiscordEventWebhook(
      signedRequest({
        application_id: APPLICATION_ID,
        type: 1,
        event: {
          type: "APPLICATION_AUTHORIZED",
          timestamp: "2026-08-14T09:00:00.000000",
          data: { integration_type: 0, user: { id: "user" } },
        },
      }),
      {
        applicationId: APPLICATION_ID,
        botToken: "token",
        getPublicKey: async () => rawPublicKey,
        fetchImpl: async () => {
          called = true;
          return Response.json({});
        },
      },
    );
    expect(response.status).toBe(204);
    expect(called).toBe(false);
  });

  test("resolves and caches the application public key", async () => {
    let calls = 0;
    const resolve = createDiscordPublicKeyResolver({
      botToken: "token",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ public_key: rawPublicKey });
      },
    });
    expect(await resolve()).toBe(rawPublicKey);
    expect(await resolve()).toBe(rawPublicKey);
    expect(calls).toBe(1);
  });

  test("accepts Discord's live verify_key application field", async () => {
    const resolve = createDiscordPublicKeyResolver({
      botToken: "token",
      fetchImpl: async () => Response.json({ verify_key: rawPublicKey }),
    });
    expect(await resolve()).toBe(rawPublicKey);
  });
});
