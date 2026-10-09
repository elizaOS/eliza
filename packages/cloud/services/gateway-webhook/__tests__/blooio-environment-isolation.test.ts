/**
 * Drives the real gateway webhook handler into a local Cloud route and proves
 * Blooio environment isolation (#22787). A staging gateway never operates a
 * production sender line and never processes a message addressed to one.
 * Production keeps its line. Only the Blooio provider API is substituted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { blooioAdapter } from "../src/adapters/blooio";
import { createRedis } from "../src/redis";
import { handleWebhook } from "../src/webhook-handler";

const WEBHOOK_SECRET = "blooio-isolation-secret";
const PRODUCTION_LINE = "+18087881821";
const STAGING_LINE = "+15550001111";
const envKeys = [
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_BLOOIO_ENVIRONMENT",
  "RAILWAY_ENVIRONMENT_NAME",
  "ELIZA_APP_WEBHOOK_PROJECT",
  "MOCK_REDIS",
] as const;
const savedEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let providerSends: Array<Record<string, unknown>>;

beforeEach(() => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  delete process.env.ELIZA_APP_BLOOIO_ENVIRONMENT;
  process.env.ELIZA_APP_WEBHOOK_PROJECT = "eliza-app";
  process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-test-key";
  process.env.ELIZA_APP_BLOOIO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.MOCK_REDIS = "1";
  providerSends = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://api.blooio.com/v4/messages") {
      providerSends.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ id: `msg_provider_${providerSends.length}` });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function startCloud() {
  const turns: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      turns.push((await request.json()) as Record<string, unknown>);
      return Response.json({ success: true, data: { reply: "Hi." } });
    },
  });
  servers.push(server);
  return { origin: server.url.origin, turns };
}

function deps(cloudBaseUrl: string) {
  return {
    redis: createRedis(),
    cloudBaseUrl,
    getAuthHeader: () => ({ Authorization: "Bearer gateway-test" }),
    reacquireAuthHeader: async () => ({ Authorization: "Bearer gateway-test" }),
  };
}

function webhook(messageId: string, recipient: string): Request {
  const body = JSON.stringify({
    id: `evt_${messageId}`,
    type: "message.received",
    created_at: Date.now(),
    data: {
      message_id: messageId,
      sender: "+15551234567",
      recipient,
      text: "hello",
      protocol: "imessage",
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return new Request("http://gateway.test/webhook/eliza-app/blooio", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-blooio-signature": `t=${timestamp},v1=${signature}`,
    },
    body,
  });
}

async function settle(): Promise<void> {
  await Bun.sleep(150);
}

describe("Blooio environment isolation", () => {
  test("a staging gateway configured with a production line disables Blooio", async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = PRODUCTION_LINE;
    const cloud = startCloud();

    const response = await handleWebhook(
      webhook("msg_iso_1", PRODUCTION_LINE),
      blooioAdapter,
      deps(cloud.origin),
      "eliza-app",
    );
    expect(response.status).toBe(404);
    await settle();
    expect(cloud.turns).toEqual([]);
    expect(providerSends).toEqual([]);
  });

  test("a staging gateway ignores a message addressed to a production line", async () => {
    process.env.ELIZA_APP_BLOOIO_ENVIRONMENT = "staging";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = STAGING_LINE;
    const cloud = startCloud();

    const foreign = await handleWebhook(
      webhook("msg_iso_2", "+1 808-788-1821"),
      blooioAdapter,
      deps(cloud.origin),
      "eliza-app",
    );
    expect(foreign.status).toBe(200);
    await settle();
    expect(cloud.turns).toEqual([]);
    expect(providerSends).toEqual([]);

    // Its own line still works end to end.
    const own = await handleWebhook(
      webhook("msg_iso_3", STAGING_LINE),
      blooioAdapter,
      deps(cloud.origin),
      "eliza-app",
    );
    expect(own.status).toBe(200);
    const deadline = Date.now() + 5_000;
    while (providerSends.length === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(cloud.turns).toHaveLength(1);
    expect(providerSends[0]).toMatchObject({ from: STAGING_LINE });
  });

  test("production keeps operating its own line", async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = PRODUCTION_LINE;
    const cloud = startCloud();

    const response = await handleWebhook(
      webhook("msg_iso_4", PRODUCTION_LINE),
      blooioAdapter,
      deps(cloud.origin),
      "eliza-app",
    );
    expect(response.status).toBe(200);
    const deadline = Date.now() + 5_000;
    while (providerSends.length === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(cloud.turns).toHaveLength(1);
    expect(providerSends[0]).toMatchObject({ from: PRODUCTION_LINE });
  });
});
