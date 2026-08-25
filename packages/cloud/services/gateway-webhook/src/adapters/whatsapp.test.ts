/**
 * Exercises the WhatsApp Cloud API gateway adapter's signature verification,
 * inbound payload extraction, and outbound Graph API delivery. Fetch is stubbed
 * only at the provider edge so assertions record observed adapter behavior
 * rather than mock return values.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { logger } from "../logger";
import { GatewayProviderFetchError } from "./bounded-fetch";
import {
  type ChatEvent,
  PlatformDeliveryError,
  type WebhookConfig,
} from "./types";
import { whatsappAdapter, whatsappFetch } from "./whatsapp";

const originalFetch = globalThis.fetch;

const inboundEvent: ChatEvent = {
  platform: "whatsapp",
  messageId: "wamid.inbound",
  chatId: "15551234567",
  senderId: "15551234567",
  text: "hello from Ada",
  rawPayload: {},
};

const deliveryConfig: WebhookConfig = {
  accessToken: "wa-access-token",
  phoneNumberId: "phone-number-id",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function signBody(appSecret: string, rawBody: string): string {
  return createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

function signedRequest(rawBody: string, appSecret: string): Request {
  return new Request("https://gateway.example/webhook/acme/whatsapp", {
    method: "POST",
    headers: {
      "x-hub-signature-256": `sha256=${signBody(appSecret, rawBody)}`,
    },
  });
}

function textMessage(
  overrides: {
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    body?: string | undefined;
    omitText?: boolean;
  } = {},
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    id: overrides.id ?? "wamid.1",
    from: overrides.from ?? "15551234567",
    timestamp: overrides.timestamp ?? "1786827000",
    type: overrides.type ?? "text",
  };
  if (!overrides.omitText) {
    message.text = { body: overrides.body ?? "hello from Ada" };
  }
  return message;
}

function webhookPayload(
  options: {
    object?: string;
    field?: string;
    messagingProduct?: string;
    messages?: Array<Record<string, unknown>> | null;
    contacts?: Array<{ wa_id: string; name: string }> | null;
    statuses?: Array<Record<string, unknown>>;
    extraEntries?: Array<Record<string, unknown>>;
    extraChanges?: Array<Record<string, unknown>>;
    emptyEntry?: boolean;
    emptyChanges?: boolean;
  } = {},
): string {
  const value: Record<string, unknown> = {
    messaging_product: options.messagingProduct ?? "whatsapp",
    metadata: {
      display_phone_number: "15550001111",
      phone_number_id: "phone-number-id",
    },
  };
  if (options.messages !== null) {
    value.messages = options.messages ?? [textMessage()];
  }
  if (options.contacts !== null && options.contacts !== undefined) {
    value.contacts = options.contacts.map((contact) => ({
      profile: { name: contact.name },
      wa_id: contact.wa_id,
    }));
  } else if (options.contacts === undefined) {
    value.contacts = [{ profile: { name: "Ada" }, wa_id: "15551234567" }];
  }
  if (options.statuses) {
    value.statuses = options.statuses;
  }

  const changes = options.emptyChanges
    ? []
    : [
        ...(options.extraChanges ?? []),
        {
          field: options.field ?? "messages",
          value,
        },
      ];

  const entry = options.emptyEntry
    ? []
    : [
        ...(options.extraEntries ?? []),
        {
          id: "waba-id",
          changes,
        },
      ];

  return JSON.stringify({
    object: options.object ?? "whatsapp_business_account",
    entry,
  });
}

describe("whatsappAdapter exports", () => {
  test("identifies the adapter as whatsapp", () => {
    expect(whatsappAdapter.platform).toBe("whatsapp");
  });
});

describe("whatsappFetch", () => {
  test("rejects a non-positive timeout before dispatching", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return Response.json({});
    }) as unknown as typeof fetch;

    await expect(
      whatsappFetch("https://graph.facebook.com/v21.0/me", undefined, 0),
    ).rejects.toBeInstanceOf(GatewayProviderFetchError);
    expect(fetches).toBe(0);
  });

  test("returns the Graph API response when the hop succeeds", async () => {
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://graph.facebook.com/v21.0/me");
      expect(request.method).toBe("GET");
      return Response.json({ id: "me" });
    }) as unknown as typeof fetch;

    const response = await whatsappFetch(
      "https://graph.facebook.com/v21.0/me",
      undefined,
      1_000,
    );
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ id: "me" });
  });
});

describe("whatsappAdapter.verifyWebhook", () => {
  test("rejects and warns when no app secret is configured", async () => {
    const warnSpy = spyOn(logger, "warn");
    const request = signedRequest("{}", "unused-secret");

    await expect(
      whatsappAdapter.verifyWebhook(request, "{}", {}),
    ).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "WhatsApp app secret not configured — signature verification skipped",
    );
  });

  test("rejects an empty app secret the same as a missing one", async () => {
    const warnSpy = spyOn(logger, "warn");
    const request = signedRequest("{}", "unused-secret");

    await expect(
      whatsappAdapter.verifyWebhook(request, "{}", { appSecret: "" }),
    ).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "WhatsApp app secret not configured — signature verification skipped",
    );
  });

  test("rejects a request that omits the signature header", async () => {
    const request = new Request("https://gateway.example/webhook");

    await expect(
      whatsappAdapter.verifyWebhook(request, "{}", { appSecret: "app-secret" }),
    ).resolves.toBe(false);
  });

  test("rejects an empty signature header", async () => {
    const request = new Request("https://gateway.example/webhook", {
      headers: { "x-hub-signature-256": "" },
    });

    await expect(
      whatsappAdapter.verifyWebhook(request, "{}", { appSecret: "app-secret" }),
    ).resolves.toBe(false);
  });

  test("accepts a matching sha256 signature without warning", async () => {
    const warnSpy = spyOn(logger, "warn");
    const rawBody = webhookPayload();
    const request = signedRequest(rawBody, "app-secret");

    await expect(
      whatsappAdapter.verifyWebhook(request, rawBody, {
        appSecret: "app-secret",
      }),
    ).resolves.toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("accepts a matching hex signature that omits the sha256= prefix", async () => {
    const rawBody = "{}";
    const request = new Request("https://gateway.example/webhook", {
      headers: {
        "x-hub-signature-256": signBody("app-secret", rawBody),
      },
    });

    await expect(
      whatsappAdapter.verifyWebhook(request, rawBody, {
        appSecret: "app-secret",
      }),
    ).resolves.toBe(true);
  });

  test("rejects a well-formed signature over a different body", async () => {
    const request = signedRequest("original-body", "app-secret");

    await expect(
      whatsappAdapter.verifyWebhook(request, "tampered-body", {
        appSecret: "app-secret",
      }),
    ).resolves.toBe(false);
  });

  test("rejects a signature computed with a different app secret", async () => {
    const rawBody = "{}";
    const request = signedRequest(rawBody, "other-secret");

    await expect(
      whatsappAdapter.verifyWebhook(request, rawBody, {
        appSecret: "app-secret",
      }),
    ).resolves.toBe(false);
  });

  test("rejects a truncated hex signature without throwing", async () => {
    const rawBody = "{}";
    const request = new Request("https://gateway.example/webhook", {
      headers: {
        "x-hub-signature-256": `sha256=${signBody("app-secret", rawBody).slice(0, 16)}`,
      },
    });

    await expect(
      whatsappAdapter.verifyWebhook(request, rawBody, {
        appSecret: "app-secret",
      }),
    ).resolves.toBe(false);
  });

  test("rejects a longer hex signature as a length mismatch", async () => {
    const rawBody = "{}";
    const request = new Request("https://gateway.example/webhook", {
      headers: {
        "x-hub-signature-256": `sha256=${signBody("app-secret", rawBody)}ab`,
      },
    });

    await expect(
      whatsappAdapter.verifyWebhook(request, rawBody, {
        appSecret: "app-secret",
      }),
    ).resolves.toBe(false);
  });

  test("returns false and warns when the app secret is not a usable HMAC key", async () => {
    const warnSpy = spyOn(logger, "warn");
    const request = signedRequest("{}", "app-secret");

    await expect(
      whatsappAdapter.verifyWebhook(request, "{}", {
        appSecret: { not: "a string" } as unknown as string,
      }),
    ).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "WhatsApp signature verification error",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});

describe("whatsappAdapter.extractEvent", () => {
  test("returns null for malformed JSON", async () => {
    const warnSpy = spyOn(logger, "warn");
    await expect(whatsappAdapter.extractEvent("{not-json")).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to parse WhatsApp webhook payload",
    );
  });

  test("returns null for a payload that fails the WhatsApp schema", async () => {
    const warnSpy = spyOn(logger, "warn");
    await expect(
      whatsappAdapter.extractEvent(
        JSON.stringify({ object: "page", entry: [] }),
      ),
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "Invalid WhatsApp webhook payload",
      expect.objectContaining({ errors: expect.anything() }),
    );
  });

  test("returns null when messaging_product is not whatsapp", async () => {
    await expect(
      whatsappAdapter.extractEvent(
        webhookPayload({ messagingProduct: "instagram" }),
      ),
    ).resolves.toBeNull();
  });

  test("returns null for an empty entry list", async () => {
    await expect(
      whatsappAdapter.extractEvent(webhookPayload({ emptyEntry: true })),
    ).resolves.toBeNull();
  });

  test("returns null for an entry with no changes", async () => {
    await expect(
      whatsappAdapter.extractEvent(webhookPayload({ emptyChanges: true })),
    ).resolves.toBeNull();
  });

  test("skips a non-messages field and returns null when nothing remains", async () => {
    await expect(
      whatsappAdapter.extractEvent(
        webhookPayload({
          field: "statuses",
          statuses: [
            {
              id: "wamid.1",
              status: "delivered",
              timestamp: "1786827000",
              recipient_id: "15551234567",
            },
          ],
          messages: null,
        }),
      ),
    ).resolves.toBeNull();
  });

  test("skips a messages field that omits the messages array", async () => {
    await expect(
      whatsappAdapter.extractEvent(webhookPayload({ messages: null })),
    ).resolves.toBeNull();
  });

  test("skips an empty messages array", async () => {
    await expect(
      whatsappAdapter.extractEvent(webhookPayload({ messages: [] })),
    ).resolves.toBeNull();
  });

  test("skips a non-text message with no later text candidate", async () => {
    await expect(
      whatsappAdapter.extractEvent(
        webhookPayload({
          messages: [textMessage({ type: "image", omitText: true })],
        }),
      ),
    ).resolves.toBeNull();
  });

  test("skips a text message that omits the body", async () => {
    await expect(
      whatsappAdapter.extractEvent(
        webhookPayload({
          messages: [textMessage({ omitText: true })],
        }),
      ),
    ).resolves.toBeNull();
  });

  test("skips a text message with an empty body", async () => {
    await expect(
      whatsappAdapter.extractEvent(
        webhookPayload({
          messages: [textMessage({ body: "" })],
        }),
      ),
    ).resolves.toBeNull();
  });

  test("normalizes the first inbound text message without calling Graph API", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return Response.json({});
    }) as unknown as typeof fetch;

    const rawBody = webhookPayload();
    const event = await whatsappAdapter.extractEvent(rawBody);

    expect(fetches).toBe(0);
    expect(event).toEqual({
      platform: "whatsapp",
      messageId: "wamid.1",
      chatId: "15551234567",
      senderId: "15551234567",
      senderName: "Ada",
      text: "hello from Ada",
      rawPayload: JSON.parse(rawBody),
    });
  });

  test("keeps senderName unset when contacts are omitted", async () => {
    const event = await whatsappAdapter.extractEvent(
      webhookPayload({ contacts: null }),
    );
    expect(event?.senderName).toBeUndefined();
    expect(event?.text).toBe("hello from Ada");
  });

  test("keeps senderName unset when the contact wa_id does not match from", async () => {
    const event = await whatsappAdapter.extractEvent(
      webhookPayload({
        contacts: [{ wa_id: "15550000000", name: "Someone else" }],
      }),
    );
    expect(event?.senderName).toBeUndefined();
  });

  test("maps senderName from the matching contact when several are present", async () => {
    const event = await whatsappAdapter.extractEvent(
      webhookPayload({
        contacts: [
          { wa_id: "15550000000", name: "Other" },
          { wa_id: "15551234567", name: "Ada Lovelace" },
        ],
      }),
    );
    expect(event?.senderName).toBe("Ada Lovelace");
  });

  test("returns the first text message and ignores later text in the same batch", async () => {
    const event = await whatsappAdapter.extractEvent(
      webhookPayload({
        messages: [
          textMessage({ id: "wamid.first", body: "first" }),
          textMessage({ id: "wamid.second", body: "second" }),
        ],
      }),
    );
    expect(event).toMatchObject({
      messageId: "wamid.first",
      text: "first",
    });
  });

  test("skips a leading non-text message and returns the first later text body", async () => {
    const event = await whatsappAdapter.extractEvent(
      webhookPayload({
        messages: [
          textMessage({ id: "wamid.image", type: "image", omitText: true }),
          textMessage({ id: "wamid.text", body: "after image" }),
        ],
      }),
    );
    expect(event).toMatchObject({
      messageId: "wamid.text",
      text: "after image",
    });
  });

  test("walks past a non-messages change to a later messages change", async () => {
    const event = await whatsappAdapter.extractEvent(
      webhookPayload({
        extraChanges: [
          {
            field: "message_echoes",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: "phone-number-id",
              },
            },
          },
        ],
        messages: [textMessage({ body: "from later change" })],
      }),
    );
    expect(event?.text).toBe("from later change");
  });

  test("walks past an earlier empty entry to a later text message", async () => {
    const event = await whatsappAdapter.extractEvent(
      webhookPayload({
        extraEntries: [{ id: "empty-waba", changes: [] }],
        messages: [textMessage({ body: "from later entry" })],
      }),
    );
    expect(event?.text).toBe("from later entry");
  });
});

describe("whatsappAdapter.sendReply and sendReplyWithReceipt", () => {
  test("fails closed when the access token is missing", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return Response.json({ messages: [{ id: "wamid.out" }] });
    }) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReply(
        { phoneNumberId: "phone-number-id" },
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      name: "PlatformDeliveryError",
      message: "Missing WhatsApp credentials for reply",
      deliveryStatus: "failed",
      code: "DELIVERY_CREDENTIALS_MISSING",
      retryable: false,
    });
    expect(fetches).toBe(0);
  });

  test("fails closed when the phone number id is missing", async () => {
    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        { accessToken: "wa-access-token" },
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toBeInstanceOf(PlatformDeliveryError);
  });

  test("posts a text reply and returns trimmed provider message ids", async () => {
    let requestUrl = "";
    let requestMethod = "";
    let requestAuth = "";
    let requestContentType = "";
    let requestBody: unknown;
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      requestUrl = request.url;
      requestMethod = request.method;
      requestAuth = request.headers.get("Authorization") ?? "";
      requestContentType = request.headers.get("Content-Type") ?? "";
      requestBody = await request.json();
      return Response.json({
        messages: [
          { id: "  wamid.out-1  " },
          { id: "   " },
          { id: 17 },
          "not-an-object",
          { id: "wamid.out-2" },
        ],
      });
    }) as unknown as typeof fetch;

    const receipt = await whatsappAdapter.sendReplyWithReceipt?.(
      deliveryConfig,
      inboundEvent,
      "hello from Eliza",
    );

    expect(receipt).toEqual({
      providerMessageIds: ["wamid.out-1", "wamid.out-2"],
    });
    expect(requestUrl).toBe(
      "https://graph.facebook.com/v21.0/phone-number-id/messages",
    );
    expect(requestMethod).toBe("POST");
    expect(requestAuth).toBe("Bearer wa-access-token");
    expect(requestContentType).toBe("application/json");
    expect(requestBody).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15551234567",
      type: "text",
      text: { body: "hello from Eliza" },
    });
  });

  test("sendReply resolves once Graph API accepts a receipt", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ messages: [{ id: "wamid.out" }] }),
    ) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReply(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).resolves.toBeUndefined();
  });

  test("treats a 4xx rejection as failed and not retryable", async () => {
    globalThis.fetch = mock(
      async () => new Response("bad request", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      deliveryStatus: "failed",
      code: "DELIVERY_PROVIDER_REJECTED",
      retryable: false,
      providerStatus: 400,
    });
  });

  test("treats a 5xx rejection as uncertain because acceptance is unknown", async () => {
    const providerFetch = mock(
      async () => new Response("provider error", { status: 500 }),
    );
    globalThis.fetch = providerFetch as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      deliveryStatus: "uncertain",
      code: "DELIVERY_PROVIDER_REJECTED",
      retryable: false,
      providerStatus: 500,
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  test("marks a 429 rejection retryable while still failed", async () => {
    globalThis.fetch = mock(
      async () => new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      deliveryStatus: "failed",
      code: "DELIVERY_PROVIDER_REJECTED",
      retryable: true,
      providerStatus: 429,
    });
  });

  test("keeps an accepted non-JSON body uncertain", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      deliveryStatus: "uncertain",
      code: "DELIVERY_RECEIPT_INVALID",
      retryable: false,
    });
  });

  test("keeps an accepted JSON body without messages uncertain", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ messaging_product: "whatsapp" }),
    ) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      deliveryStatus: "uncertain",
      code: "DELIVERY_RECEIPT_INVALID",
      retryable: false,
    });
  });

  test("keeps an accepted non-object receipt uncertain", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(null),
    ) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      code: "DELIVERY_RECEIPT_INVALID",
      deliveryStatus: "uncertain",
    });
  });

  test("keeps an accepted empty messages array uncertain", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ messages: [] }),
    ) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      deliveryStatus: "uncertain",
      code: "DELIVERY_RECEIPT_INVALID",
      retryable: false,
    });
  });

  test("drops non-string message ids until none remain, then fails closed", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        messages: [{ id: 1 }, { sid: "wamid.looks-like-it" }, null],
      }),
    ) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendReplyWithReceipt?.(
        deliveryConfig,
        inboundEvent,
        "hello from Eliza",
      ),
    ).rejects.toMatchObject({
      message: "WhatsApp accepted delivery without a message receipt",
      code: "DELIVERY_RECEIPT_INVALID",
    });
  });
});

describe("whatsappAdapter.sendTypingIndicator", () => {
  test("does not call Graph API when credentials are missing", async () => {
    let fetches = 0;
    globalThis.fetch = mock(async () => {
      fetches += 1;
      return Response.json({});
    }) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendTypingIndicator({}, inboundEvent),
    ).resolves.toBeUndefined();
    await expect(
      whatsappAdapter.sendTypingIndicator(
        { accessToken: "wa-access-token" },
        inboundEvent,
      ),
    ).resolves.toBeUndefined();
    await expect(
      whatsappAdapter.sendTypingIndicator(
        { phoneNumberId: "phone-number-id" },
        inboundEvent,
      ),
    ).resolves.toBeUndefined();
    expect(fetches).toBe(0);
  });

  test("marks the inbound message read on the Graph API", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      requestUrl = request.url;
      requestBody = await request.json();
      return Response.json({ success: true });
    }) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendTypingIndicator(deliveryConfig, inboundEvent),
    ).resolves.toBeUndefined();
    expect(requestUrl).toBe(
      "https://graph.facebook.com/v21.0/phone-number-id/messages",
    );
    expect(requestBody).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.inbound",
    });
  });

  test("swallows a Graph API failure as fire-and-forget", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("graph unavailable");
    }) as unknown as typeof fetch;

    await expect(
      whatsappAdapter.sendTypingIndicator(deliveryConfig, inboundEvent),
    ).resolves.toBeUndefined();
  });
});
