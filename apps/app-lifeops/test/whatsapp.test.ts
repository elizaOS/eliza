import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withWhatsApp } from "../src/lifeops/service-mixin-whatsapp.js";
import { LifeOpsServiceError } from "../src/lifeops/service-types.js";
import {
  parseWhatsAppWebhookMessages,
  readWhatsAppCredentialsFromEnv,
  sendWhatsAppMessage,
  WhatsAppError,
} from "../src/lifeops/whatsapp-client.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
let workspaceDir: string;

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("ELIZA_WHATSAPP_")) delete process.env[k];
  }
  workspaceDir = mkdtempSync(path.join(tmpdir(), "lifeops-whatsapp-test-"));
  process.env.ELIZA_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
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
    expect(creds?.accessToken).toBe("tok-abc");
    expect(creds?.phoneNumberId).toBe("555000111");
  });
});

describe("sendWhatsAppMessage", () => {
  test("POSTs to graph.facebook.com with Bearer auth and correct body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedInit = init;
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.123" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
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

  test("includes reply context when replying to an inbound message", async () => {
    let capturedBody: unknown;
    global.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.reply" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ) as unknown as typeof fetch;

    const result = await sendWhatsAppMessage(
      {
        accessToken: "tok-abc",
        phoneNumberId: "555000111",
        apiVersion: "v21.0",
      },
      {
        to: "+15551112222",
        text: "reply text",
        replyToMessageId: "wamid.source",
      },
    );

    expect(result.messageId).toBe("wamid.reply");
    expect(capturedBody).toMatchObject({
      context: { message_id: "wamid.source" },
      text: { body: "reply text" },
    });
  });

  test("throws WhatsAppError on non-2xx", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid token" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
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
                metadata: {
                  display_phone_number: "+1 555 000 1111",
                  phone_number_id: "phone-555000111",
                },
                contacts: [
                  {
                    profile: { name: "Eve WhatsApp" },
                    wa_id: "15551112222",
                  },
                ],
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
    expect(messages[0].channelId).toBe("15551112222");
    expect(messages[0].type).toBe("text");
    expect(messages[0].text).toBe("hello!");
    expect(messages[0].metadata).toEqual({
      displayPhoneNumber: "+1 555 000 1111",
      phoneNumberId: "phone-555000111",
      contactName: "Eve WhatsApp",
      waId: "15551112222",
    });
    expect(messages[1].text).toBe("hi");
  });

  test("rejects messages without a valid WhatsApp timestamp", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.bad-timestamp",
                    from: "15551112222",
                    timestamp: "not-a-number",
                    type: "text",
                    text: { body: "should not ingest" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(parseWhatsAppWebhookMessages(payload)).toEqual([]);
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
    runtime = {
      agentId: "test",
      getService: vi.fn(() => null),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      setSetting: vi.fn(),
    };
    ownerEntityId = null;
  }
  const Composed = withWhatsApp(StubBase as never);
  // biome-ignore lint/suspicious/noExplicitAny: mixin stub
  const svc = new (Composed as any)();

  beforeEach(() => {
    svc.runtime.getService.mockReset();
    svc.runtime.getService.mockReturnValue(null);
    svc.runtime.setSetting.mockReset();
  });

  test("getWhatsAppConnectorStatus reports connected: false without creds", async () => {
    const status = await svc.getWhatsAppConnectorStatus();
    expect(status.connected).toBe(false);
    expect(status.provider).toBe("whatsapp");
    expect(typeof status.lastCheckedAt).toBe("string");
  });

  test("getWhatsAppConnectorStatus reports local QR auth without enabling the plugin", async () => {
    const authDir = path.join(workspaceDir, "lifeops-whatsapp-auth", "default");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(path.join(authDir, "creds.json"), "{}");
    svc.runtime.getService.mockReturnValue({ connected: true });

    const status = await svc.getWhatsAppConnectorStatus();

    expect(status.connected).toBe(true);
    expect(status.localAuthAvailable).toBe(true);
    expect(status.serviceConnected).toBe(true);
    expect(status.transport).toBe("baileys");
    expect(status.phoneNumberId).toBeUndefined();
    expect(status.degradations).toEqual([
      expect.objectContaining({
        axis: "delivery-degraded",
        code: "business_cloud_credentials_missing",
      }),
    ]);
    expect(svc.runtime.setSetting).toHaveBeenCalledWith(
      "WHATSAPP_AUTH_DIR",
      authDir,
      false,
    );
  });

  test("getWhatsAppConnectorStatus ignores user-facing WhatsApp runtime service", async () => {
    svc.runtime.getService.mockReturnValue({ connected: true });

    const status = await svc.getWhatsAppConnectorStatus();

    expect(status.connected).toBe(false);
    expect(status.serviceConnected).toBe(false);
    expect(svc.runtime.getService).not.toHaveBeenCalled();
  });

  test("sendWhatsAppMessage throws LifeOpsServiceError without creds", async () => {
    await expect(
      svc.sendWhatsAppMessage({ to: "+1", text: "x" }),
    ).rejects.toBeInstanceOf(LifeOpsServiceError);
  });

  test("sendWhatsAppMessage uses configured Cloud API credentials", async () => {
    process.env.ELIZA_WHATSAPP_ACCESS_TOKEN = "tok-service";
    process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID = "phone-service";
    process.env.ELIZA_WHATSAPP_API_VERSION = "v21.0";
    process.env.MILADY_MOCK_WHATSAPP_BASE = "http://127.0.0.1:7879";
    let capturedUrl = "";
    let capturedBody: unknown;
    global.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.service" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ) as unknown as typeof fetch;

    await expect(
      svc.sendWhatsAppMessage({ to: "+15551112222", text: "service send" }),
    ).resolves.toEqual({ ok: true, messageId: "wamid.service" });
    expect(capturedUrl).toBe(
      "http://127.0.0.1:7879/v21.0/phone-service/messages",
    );
    expect(capturedBody).toEqual({
      messaging_product: "whatsapp",
      to: "+15551112222",
      type: "text",
      text: { body: "service send" },
    });
  });

  test("sendWhatsAppMessage uses the local runtime service when only QR auth is available", async () => {
    const authDir = path.join(workspaceDir, "lifeops-whatsapp-auth", "default");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(path.join(authDir, "creds.json"), "{}");
    const sendMessage = vi.fn(async () => ({
      messages: [{ id: "wamid.local" }],
    }));
    svc.runtime.getService.mockReturnValue({
      connected: true,
      sendMessage,
    });

    await expect(
      svc.sendWhatsAppMessage({ to: "+15551112222", text: "local send" }),
    ).resolves.toEqual({ ok: true, messageId: "wamid.local" });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "text",
      to: "+15551112222",
      content: "local send",
    });
  });

  test("sendWhatsAppMessage surfaces Cloud API delivery failures", async () => {
    process.env.ELIZA_WHATSAPP_ACCESS_TOKEN = "tok-service";
    process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID = "phone-service";
    process.env.MILADY_MOCK_WHATSAPP_BASE = "http://127.0.0.1:7879";
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "recipient is not allowed" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    await expect(
      svc.sendWhatsAppMessage({ to: "+15551112222", text: "blocked" }),
    ).rejects.toMatchObject({
      status: 400,
      message: "recipient is not allowed",
    });
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
