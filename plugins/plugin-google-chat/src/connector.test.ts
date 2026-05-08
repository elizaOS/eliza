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
    } as unknown as IAgentRuntime;
    const service = Object.create(GoogleChatService.prototype) as GoogleChatService;
    (service as unknown as { settings: { accountId: string } }).settings = {
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
        space: "spaces/AAA",
        text: "hello",
        thread: "spaces/AAA/threads/T1",
      })
    );
  });
});
