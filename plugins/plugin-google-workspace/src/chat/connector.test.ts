/**
 * Verifies the Google Chat message connector registers with the runtime and
 * routes outbound sends correctly, against a mocked runtime — no Google API
 * calls.
 */
import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { GoogleChatService } from "./service.js";
import {
  GoogleChatApiError,
  GoogleChatConfigurationError,
  MAX_GOOGLE_CHAT_MESSAGE_LENGTH,
  splitMessageForGoogleChat,
} from "./types.js";

describe("Google Chat message connector", () => {
  function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
    return {
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getSetting: vi.fn((key: string) =>
        key === "GOOGLE_CHAT_DEFAULT_ACCOUNT_ID" ? "workspace" : null
      ),
      character: { settings: {} },
      getRoom: vi.fn(),
      ...overrides,
    } as IAgentRuntime;
  }

  function serviceWithState(accountId = "workspace") {
    const service = Object.create(GoogleChatService.prototype) as GoogleChatService;
    const states = new Map([
      [
        accountId,
        {
          accountId,
          settings: {
            accountId,
            audienceType: "app-url",
            audience: "https://example.com/googlechat",
            webhookPath: "/googlechat",
            spaces: [],
            requireMention: true,
            enabled: true,
          },
          auth: {},
          connected: true,
          cachedSpaces: [],
        },
      ],
    ]);
    (service as { states: typeof states; defaultAccountId: string }).states = states;
    (service as { states: typeof states; defaultAccountId: string }).defaultAccountId = accountId;
    return service;
  }

  function serviceWithFetch(fetchImpl: typeof fetch): GoogleChatService {
    const service = serviceWithState();
    Object.assign(service, {
      fetchImpl,
      chatTimeoutMs: 1_000,
      runtime: undefined,
    });
    vi.spyOn(service, "getAccessToken").mockResolvedValue("test-token");
    return service;
  }

  it("stays dormant without configuration so RECENT_ERRORS receives no service-start failure", async () => {
    const reportError = vi.fn();
    const runtimeInstance = runtime({
      getSetting: vi.fn(() => null),
      emitEvent: vi.fn(),
      reportError,
    });

    const service = await GoogleChatService.start(runtimeInstance);

    expect(service).toBeInstanceOf(GoogleChatService);
    expect(runtimeInstance.registerMessageConnector).not.toHaveBeenCalled();
    expect(runtimeInstance.emitEvent).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("still fails fast when an explicitly enabled account lacks credentials", async () => {
    const runtimeInstance = runtime({
      getSetting: vi.fn((key: string) =>
        key === "GOOGLE_CHAT_ACCOUNTS"
          ? JSON.stringify({
              workspace: {
                enabled: true,
                audience: "https://example.com/googlechat",
              },
            })
          : null
      ),
      reportError: vi.fn(),
    });

    await expect(GoogleChatService.start(runtimeInstance)).rejects.toBeInstanceOf(
      GoogleChatConfigurationError
    );
  });

  it("does not let a named account inherit owner application-default credentials", async () => {
    const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/owner/application-default.json";
    try {
      const runtimeInstance = runtime({
        getSetting: vi.fn((key: string) =>
          key === "GOOGLE_CHAT_ACCOUNTS"
            ? JSON.stringify({
                workspace: {
                  enabled: true,
                  audience: "https://example.com/googlechat",
                },
              })
            : null
        ),
        reportError: vi.fn(),
      });

      await expect(GoogleChatService.start(runtimeInstance)).rejects.toBeInstanceOf(
        GoogleChatConfigurationError
      );
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
    }
  });

  it("registers connector metadata and routes space sends", async () => {
    const runtimeInstance = runtime();
    const service = Object.create(GoogleChatService.prototype) as GoogleChatService;
    (service as { settings: { accountId: string } }).settings = {
      accountId: "workspace",
    };
    (service as { auth: object }).auth = {};
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, space: "spaces/AAA" });

    GoogleChatService.registerSendHandlers(runtimeInstance, service);

    expect(runtimeInstance.registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "google-chat",
        accountId: "workspace",
        label: "Google Chat",
        capabilities: expect.arrayContaining(["send_message", "send_thread_reply"]),
        supportedTargetKinds: expect.arrayContaining(["room", "thread", "user"]),
      })
    );

    const registration = vi.mocked(runtimeInstance.registerMessageConnector).mock.calls[0][0];
    await registration.sendHandler(
      runtimeInstance,
      {
        source: "google-chat",
        accountId: "workspace",
        channelId: "spaces/AAA",
        threadId: "spaces/AAA/threads/T1",
      } as TargetInfo,
      { text: "hello" } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "workspace",
        space: "spaces/AAA",
        text: "hello",
        thread: "spaces/AAA/threads/T1",
      })
    );
  });

  it("registers account-scoped connectors and routes sends through the requested account", async () => {
    const runtimeInstance = runtime({ getSetting: vi.fn() });
    const service = Object.create(GoogleChatService.prototype) as GoogleChatService;
    const states = new Map([
      [
        "workspace",
        {
          accountId: "workspace",
          settings: { accountId: "workspace" },
          auth: {},
          connected: true,
          cachedSpaces: [],
        },
      ],
      [
        "partner",
        {
          accountId: "partner",
          settings: { accountId: "partner" },
          auth: {},
          connected: true,
          cachedSpaces: [],
        },
      ],
    ]);
    (service as { states: typeof states; defaultAccountId: string }).states = states;
    (service as { states: typeof states; defaultAccountId: string }).defaultAccountId = "workspace";
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, space: "spaces/PARTNER" });

    GoogleChatService.registerSendHandlers(runtimeInstance, service, "workspace");
    GoogleChatService.registerSendHandlers(runtimeInstance, service, "partner");

    expect(runtimeInstance.registerMessageConnector).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(runtimeInstance.registerMessageConnector)
        .mock.calls.map(([registration]) => registration.accountId)
    ).toEqual(["workspace", "partner"]);

    const partnerRegistration = vi.mocked(runtimeInstance.registerMessageConnector).mock
      .calls[1][0];
    await partnerRegistration.sendHandler(
      runtimeInstance,
      {
        source: "google-chat",
        accountId: "partner",
        channelId: "spaces/PARTNER",
      } as TargetInfo,
      { text: "partner hello" } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "partner",
        space: "spaces/PARTNER",
        text: "partner hello",
      })
    );
  });

  it("rejects hostile or unresolved connector targets before sending", async () => {
    const runtimeInstance = runtime({
      getRoom: vi.fn(async () => ({ id: "room-1" })),
    });
    const service = serviceWithState();
    const sendMessageSpy = vi.spyOn(service, "sendMessage");

    GoogleChatService.registerSendHandlers(runtimeInstance, service, "workspace");
    const registration = vi.mocked(runtimeInstance.registerMessageConnector).mock.calls[0][0];

    await expect(
      registration.sendHandler(
        runtimeInstance,
        { source: "google-chat", accountId: "workspace" } as TargetInfo,
        { text: "hello" } as Content
      )
    ).rejects.toThrow("missing a space or user resource name");

    await expect(
      registration.sendHandler(
        runtimeInstance,
        {
          source: "google-chat",
          accountId: "workspace",
          channelId: "spaces/../../bad",
        } as TargetInfo,
        { text: "hello" } as Content
      )
    ).rejects.toThrow("Invalid Google Chat target");

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("drops blank sends but keeps attachment-only sends", async () => {
    const runtimeInstance = runtime();
    const service = serviceWithState();
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, messageName: "spaces/AAA/messages/1" });

    GoogleChatService.registerSendHandlers(runtimeInstance, service, "workspace");
    const registration = vi.mocked(runtimeInstance.registerMessageConnector).mock.calls[0][0];

    await registration.sendHandler(
      runtimeInstance,
      { source: "google-chat", accountId: "workspace", channelId: "spaces/AAA" } as TargetInfo,
      { text: " \n\t " } as Content
    );
    expect(sendMessageSpy).not.toHaveBeenCalled();

    await registration.sendHandler(
      runtimeInstance,
      { source: "google-chat", accountId: "workspace", channelId: "spaces/AAA" } as TargetInfo,
      {
        data: {
          googleChat: {
            attachments: [{ attachmentUploadToken: "upload-token", contentName: "file.txt" }],
          },
        },
      } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "workspace",
        space: "spaces/AAA",
        attachments: [{ attachmentUploadToken: "upload-token", contentName: "file.txt" }],
      })
    );
  });

  it("sends long text chunks in order with thread metadata and one attachment", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const service = serviceWithFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ name: `spaces/AAA/messages/${requests.length}` });
    });
    const text = "🙂".repeat(2_500);

    const result = await service.sendMessage({
      accountId: "workspace",
      space: "spaces/AAA",
      thread: "spaces/AAA/threads/T1",
      text,
      attachments: [{ attachmentUploadToken: "upload-token", contentName: "file.txt" }],
    });

    expect(requests).toHaveLength(2);
    const sentText = requests.map((request) => String(request.text));
    expect(sentText.join("")).toBe(text);
    expect(sentText.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(sentText.every((chunk) => chunk.isWellFormed())).toBe(true);
    expect(requests.map((request) => request.thread)).toEqual([
      { name: "spaces/AAA/threads/T1" },
      { name: "spaces/AAA/threads/T1" },
    ]);
    expect(requests[0].attachment).toHaveLength(1);
    expect(requests[1]).not.toHaveProperty("attachment");
    expect(result.messageName).toBe("spaces/AAA/messages/2");
  });

  it("stops long-message delivery on the first provider failure", async () => {
    let requestCount = 0;
    const service = serviceWithFetch(async () => {
      requestCount += 1;
      return requestCount === 2
        ? new Response("quota exceeded", { status: 429 })
        : Response.json({ name: `spaces/AAA/messages/${requestCount}` });
    });

    await expect(
      service.sendMessage({
        accountId: "workspace",
        space: "spaces/AAA",
        text: "🙂".repeat(4_500),
      })
    ).rejects.toBeInstanceOf(GoogleChatApiError);

    expect(requestCount).toBe(2);
  });

  it("validates reaction, edit, and delete mutation parameters before API calls", async () => {
    const runtimeInstance = runtime();
    const service = serviceWithState();
    const sendReaction = vi.spyOn(service, "sendReaction");
    const updateMessage = vi.spyOn(service, "updateMessage");
    const deleteMessage = vi.spyOn(service, "deleteMessage");

    GoogleChatService.registerSendHandlers(runtimeInstance, service, "workspace");
    const registration = vi.mocked(runtimeInstance.registerMessageConnector).mock.calls[0][0];

    await expect(
      registration.reactHandler?.(runtimeInstance, { messageId: "msg-1" })
    ).rejects.toThrow("requires emoji");
    await expect(
      registration.editHandler?.(runtimeInstance, { messageId: "msg-1", text: " " })
    ).rejects.toThrow("requires text content");
    await expect(registration.deleteHandler?.(runtimeInstance, {})).rejects.toThrow(
      "requires messageId"
    );

    expect(sendReaction).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});

describe("splitMessageForGoogleChat surrogate pair safety", () => {
  it("keeps a surrogate pair (emoji) intact instead of splitting it across chunks", () => {
    const text = `a${"🙂".repeat(MAX_GOOGLE_CHAT_MESSAGE_LENGTH)}`;

    const chunks = splitMessageForGoogleChat(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
      expect(chunk.isWellFormed()).toBe(true);
    }
  });

  it("returns original text when under maxLength", () => {
    expect(splitMessageForGoogleChat("hello")).toEqual(["hello"]);
  });

  it("keeps the exact provider boundary and chunks one unit beyond it", () => {
    const exact = "a".repeat(MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
    expect(splitMessageForGoogleChat(exact)).toEqual([exact]);

    const over = `${exact}b`;
    const chunks = splitMessageForGoogleChat(over);
    expect(chunks.map((chunk) => chunk.length)).toEqual([4_000, 1]);
    expect(chunks.join("")).toBe(over);
  });

  it("does not let a whitespace break exceed the provider limit", () => {
    const chunks = splitMessageForGoogleChat(`${"a".repeat(MAX_GOOGLE_CHAT_MESSAGE_LENGTH)} b`);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks).toEqual(["a".repeat(4_000), "b"]);
  });

  it.each([1, 0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid maxLength %s instead of stalling",
    (maxLength) => {
      expect(() => splitMessageForGoogleChat("🙂x", maxLength)).toThrow(
        "maxLength must be an integer of at least 2"
      );
    }
  );

  it("replaces pre-existing lone surrogates before returning wire text", () => {
    const chunks = splitMessageForGoogleChat(`\uD83Dvalid\uDC00`);
    expect(chunks).toEqual(["�valid�"]);
    expect(chunks.every((chunk) => chunk.isWellFormed())).toBe(true);
  });
});
