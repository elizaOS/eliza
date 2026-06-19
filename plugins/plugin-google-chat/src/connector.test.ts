import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { GoogleChatService } from "./service.js";

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

  it("registers connector metadata and routes space sends", async () => {
    const runtimeInstance = runtime();
    const service = Object.create(GoogleChatService.prototype) as GoogleChatService;
    (service as { settings: { accountId: string } }).settings = {
      accountId: "workspace",
    };
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
