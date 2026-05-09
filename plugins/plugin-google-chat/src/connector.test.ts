import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { GoogleChatService } from "./service.js";

describe("Google Chat message connector", () => {
  it("registers connector metadata and routes space sends", async () => {
    const runtime = {
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getSetting: vi.fn((key: string) =>
        key === "GOOGLE_CHAT_DEFAULT_ACCOUNT_ID" ? "workspace" : null
      ),
      character: { settings: {} },
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.create(GoogleChatService.prototype) as GoogleChatService;
    (service as { settings: { accountId: string } }).settings = {
      accountId: "workspace",
    };
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, space: "spaces/AAA" });

    GoogleChatService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "google-chat",
        accountId: "workspace",
        label: "Google Chat",
        capabilities: expect.arrayContaining(["send_message", "send_thread_reply"]),
        supportedTargetKinds: expect.arrayContaining(["room", "thread", "user"]),
      })
    );

    const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];
    await registration.sendHandler(
      runtime,
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
    const runtime = {
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getSetting: vi.fn(),
      character: { settings: {} },
      getRoom: vi.fn(),
    } as IAgentRuntime;
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
    (service as { states: typeof states; defaultAccountId: string }).defaultAccountId =
      "workspace";
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, space: "spaces/PARTNER" });

    GoogleChatService.registerSendHandlers(runtime, service, "workspace");
    GoogleChatService.registerSendHandlers(runtime, service, "partner");

    expect(runtime.registerMessageConnector).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(runtime.registerMessageConnector)
        .mock.calls.map(([registration]) => registration.accountId)
    ).toEqual(["workspace", "partner"]);

    const partnerRegistration = vi.mocked(runtime.registerMessageConnector).mock.calls[1][0];
    await partnerRegistration.sendHandler(
      runtime,
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
});
