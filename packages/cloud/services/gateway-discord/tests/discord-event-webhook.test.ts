/**
 * Exercises signed Discord application-event parsing and the Hono route's
 * bounded durable-enqueue boundary with deterministic crypto fixtures.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  createDiscordEventWebhookApp,
  createDiscordPublicKeyResolver,
  handleDiscordEventWebhook,
  verifyDiscordEventSignature,
} from "../src/discord-event-webhook";
import type { DiscordInstallWelcomeJob } from "../src/discord-install-welcome-queue";

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

function userInstallPayload(integrationType = 1) {
  return {
    application_id: APPLICATION_ID,
    type: 1,
    event: {
      type: "APPLICATION_AUTHORIZED",
      timestamp: "2026-08-14T09:00:00.000000",
      data: {
        integration_type: integrationType,
        user: { id: "498273781589213185", global_name: "shaw" },
      },
    },
  };
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
        getPublicKey: async () => rawPublicKey,
        enqueue: async () => undefined,
      },
    );
    expect(response.status).toBe(401);
  });

  test("acknowledges Discord endpoint validation pings", async () => {
    const response = await handleDiscordEventWebhook(
      signedRequest({ application_id: APPLICATION_ID, type: 0 }),
      {
        applicationId: APPLICATION_ID,
        getPublicKey: async () => rawPublicKey,
        enqueue: async () => undefined,
      },
    );
    expect(response.status).toBe(204);
  });

  test("durably enqueues a stable welcome job without calling Discord REST", async () => {
    const jobs: DiscordInstallWelcomeJob[] = [];
    const response = await handleDiscordEventWebhook(
      signedRequest(userInstallPayload()),
      {
        applicationId: APPLICATION_ID,
        getPublicKey: async () => rawPublicKey,
        enqueue: async (job) => {
          jobs.push(job);
        },
      },
    );

    expect(response.status).toBe(204);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      eventTimestamp: "2026-08-14T09:00:00.000000",
      user: { id: "498273781589213185", globalName: "shaw" },
    });
    expect(jobs[0]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ignores guild installs", async () => {
    let called = false;
    const response = await handleDiscordEventWebhook(
      signedRequest(userInstallPayload(0)),
      {
        applicationId: APPLICATION_ID,
        getPublicKey: async () => rawPublicKey,
        enqueue: async () => {
          called = true;
        },
      },
    );
    expect(response.status).toBe(204);
    expect(called).toBe(false);
  });

  test("Hono boundary honors the bot-enabled flag", async () => {
    let keyResolved = false;
    const app = createDiscordEventWebhookApp({
      enabled: false,
      applicationId: APPLICATION_ID,
      getPublicKey: async () => {
        keyResolved = true;
        return rawPublicKey;
      },
      enqueue: async () => undefined,
    });

    const response = await app.request(signedRequest(userInstallPayload()));
    expect(response.status).toBe(503);
    expect(keyResolved).toBe(false);
  });

  test("Hono boundary ACKs well under three seconds after Redis enqueue", async () => {
    const app = createDiscordEventWebhookApp({
      enabled: true,
      applicationId: APPLICATION_ID,
      getPublicKey: async () => rawPublicKey,
      enqueue: async () => undefined,
    });
    const startedAt = performance.now();
    const response = await app.request(signedRequest(userInstallPayload()));
    expect(response.status).toBe(204);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("Hono boundary fails within the ACK budget when Redis stalls", async () => {
    const errors: string[] = [];
    const app = createDiscordEventWebhookApp({
      enabled: true,
      applicationId: APPLICATION_ID,
      getPublicKey: async () => rawPublicKey,
      enqueue: () => new Promise(() => undefined),
      logError: (_message, context) => errors.push(context.error),
    });
    const startedAt = performance.now();
    const response = await app.request(signedRequest(userInstallPayload()));
    const elapsed = performance.now() - startedAt;
    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(2_500);
    expect(errors).toEqual(["Discord install welcome enqueue timed out"]);
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
