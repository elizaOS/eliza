import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  parseWhatsAppWebhookMessages,
  readWhatsAppCredentialsFromEnv,
  sendWhatsAppMessage,
  WhatsAppError,
} from "../src/lifeops/whatsapp-client.js";
import { withWhatsApp } from "../src/lifeops/service-mixin-whatsapp.js";
import { LifeOpsServiceError } from "../src/lifeops/service-types.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("ELIZA_WHATSAPP_")) delete process.env[k];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("readWhatsAppCredentialsFromEnv", () => {
  test("returns null without env vars", () => {
    expect(readWhatsAppCredentialsFromEnv()).toBeNull();
  });

  test("returns object when both env vars set", () => {
    process.env.ELIZA_WHATSAPP_ACCESS_TOKEN = "tok-abc";
    process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID = "555000111";
    const creds = readWhatsAppCredentialsFromEnv();
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe("tok-abc");
    expect(creds!.phoneNumberId).toBe("555000111");
  });
});

describe("sendWhatsAppMessage", () => {
  test("POSTs to graph.facebook.com with Bearer auth and correct body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.123" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendWhatsAppMessage(
      {
        accessToken: "tok-abc",
        phoneNumberId: "555000111",
        apiVersion: "v21.0",
      },
      { to: "+15551112222", text: "hi there" },
    );

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("wamid.123");
    expect(capturedUrl).toBe(
      "https://graph.facebook.com/v21.0/555000111/messages",
    );
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "+15551112222",
      type: "text",
      text: { body: "hi there" },
    });
  });

  test("throws WhatsAppError on non-2xx", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: "invalid token" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    await expect(
      sendWhatsAppMessage(
        { accessToken: "bad", phoneNumberId: "111" },
        { to: "+1", text: "x" },
      ),
    ).rejects.toBeInstanceOf(WhatsAppError);
  });
});

describe("parseWhatsAppWebhookMessages", () => {
  test("extracts text messages from nested entry/changes/value/messages", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.aaa",
                    from: "15551112222",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "hello!" },
                  },
                  {
                    id: "wamid.bbb",
                    from: "15553334444",
                    timestamp: "1700000050",
                    type: "text",
                    text: { body: "hi" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = parseWhatsAppWebhookMessages(payload);
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("wamid.aaa");
    expect(messages[0].from).toBe("15551112222");
    expect(messages[0].type).toBe("text");
    expect(messages[0].text).toBe("hello!");
    expect(messages[1].text).toBe("hi");
  });

  test("returns [] for malformed payloads", () => {
    expect(parseWhatsAppWebhookMessages(null)).toEqual([]);
    expect(parseWhatsAppWebhookMessages(undefined)).toEqual([]);
    expect(parseWhatsAppWebhookMessages({})).toEqual([]);
    expect(parseWhatsAppWebhookMessages({ entry: "nope" })).toEqual([]);
    expect(
      parseWhatsAppWebhookMessages({ entry: [{ changes: "nope" }] }),
    ).toEqual([]);
  });
});

describe("withWhatsApp mixin", () => {
  class StubBase {
    runtime = { agentId: "test", logger: console };
    ownerEntityId = null;
  }
  const Composed = withWhatsApp(StubBase as never);
  // biome-ignore lint/suspicious/noExplicitAny: mixin stub
  const svc = new (Composed as any)();

  test("getWhatsAppConnectorStatus reports connected: false without creds", async () => {
    const status = await svc.getWhatsAppConnectorStatus();
    expect(status.connected).toBe(false);
    expect(status.provider).toBe("whatsapp");
    expect(typeof status.lastCheckedAt).toBe("string");
  });

  test("sendWhatsAppMessage throws LifeOpsServiceError without creds", async () => {
    await expect(
      svc.sendWhatsAppMessage({ to: "+1", text: "x" }),
    ).rejects.toBeInstanceOf(LifeOpsServiceError);
  });

  test("ingestWhatsAppWebhook parses payload and returns count", async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.zzz",
                    from: "15559998888",
                    timestamp: "1700001000",
                    type: "text",
                    text: { body: "yo" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const result = await svc.ingestWhatsAppWebhook(payload);
    expect(result.ingested).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("wamid.zzz");
  });
});
