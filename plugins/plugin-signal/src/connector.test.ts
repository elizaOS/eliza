import type { Content, IAgentRuntime, TargetInfo, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SignalService } from "./service";

describe("Signal message connector", () => {
  it("registers connector metadata and routes direct sends", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.create(SignalService.prototype) as SignalService;
    const sendMessageSpy = vi.spyOn(service, "sendMessage").mockResolvedValue({ timestamp: 123 });

    SignalService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "signal",
        label: "Signal",
        capabilities: expect.arrayContaining(["send_message", "send_group_message"]),
        supportedTargetKinds: expect.arrayContaining(["contact", "group"]),
      })
    );

    const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];
    await registration.sendHandler(
      runtime,
      { source: "signal", channelId: "+15551234567" } as TargetInfo,
      { text: "hello" } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith("+15551234567", "hello", {
      record: false,
      accountId: "default",
    });
  });

  it("does not send blank connector messages", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.create(SignalService.prototype) as SignalService;
    const sendMessageSpy = vi.spyOn(service, "sendMessage").mockResolvedValue({ timestamp: 123 });

    SignalService.registerSendHandlers(runtime, service);
    const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];
    await registration.sendHandler(
      runtime,
      { source: "signal", channelId: "+15551234567" } as TargetInfo,
      { text: "   " } as Content
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(runtime.getRoom).not.toHaveBeenCalled();
  });

  it("rejects connector sends without a channel or room target", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.create(SignalService.prototype) as SignalService;
    const sendMessageSpy = vi.spyOn(service, "sendMessage").mockResolvedValue({ timestamp: 123 });

    SignalService.registerSendHandlers(runtime, service);
    const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];

    await expect(
      registration.sendHandler(
        runtime,
        { source: "signal" } as TargetInfo,
        { text: "hello" } as Content
      )
    ).rejects.toThrow("Signal target is missing a channel identifier");
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("threads target accountId into sends and returned memories", async () => {
    const roomId = "room-1" as UUID;
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(async () => ({ id: roomId, source: "signal", channelId: "+15551234567" })),
    } as IAgentRuntime;
    const service = Object.create(SignalService.prototype) as SignalService;
    const sendMessageSpy = vi.spyOn(service, "sendMessage").mockResolvedValue({ timestamp: 456 });

    SignalService.registerSendHandlers(runtime, service);
    const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];
    const memory = await registration.sendHandler(
      runtime,
      {
        source: "signal",
        accountId: "work",
        channelId: "+15551234567",
        roomId,
      } as TargetInfo,
      { text: "hello" } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith("+15551234567", "hello", {
      record: false,
      accountId: "work",
    });
    expect(memory?.metadata).toEqual(
      expect.objectContaining({
        accountId: "work",
        messageIdFull: "456",
      })
    );
  });

  it("uses the account-scoped registration account when targets omit accountId", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.assign(Object.create(SignalService.prototype), {
      defaultAccountId: "personal",
      clients: new Map([
        ["personal", {}],
        ["work", {}],
      ]),
    }) as SignalService;
    const sendMessageSpy = vi.spyOn(service, "sendMessage").mockResolvedValue({ timestamp: 789 });

    SignalService.registerSendHandlers(runtime, service);
    const registrations = vi
      .mocked(runtime.registerMessageConnector)
      .mock.calls.map((call) => call[0]);
    const workRegistration = registrations.find(
      (registration) => registration.accountId === "work"
    );

    await workRegistration?.sendHandler?.(
      runtime,
      { source: "signal", channelId: "+15551234567" } as TargetInfo,
      { text: "hello" } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith("+15551234567", "hello", {
      record: false,
      accountId: "work",
    });
  });

  it("passes account-scoped context into read hooks", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.assign(Object.create(SignalService.prototype), {
      defaultAccountId: "personal",
      clients: new Map([
        ["personal", {}],
        ["work", {}],
      ]),
      fetchConnectorMessages: vi.fn(async () => []),
    }) as SignalService & {
      fetchConnectorMessages: ReturnType<typeof vi.fn>;
    };

    SignalService.registerSendHandlers(runtime, service);
    const workRegistration = vi
      .mocked(runtime.registerMessageConnector)
      .mock.calls.map((call) => call[0])
      .find((registration) => registration.accountId === "work");

    await workRegistration?.fetchMessages?.(
      { runtime },
      { target: { source: "signal", channelId: "+15551234567" } as TargetInfo, limit: 5 }
    );

    expect(service.fetchConnectorMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
      }),
      expect.objectContaining({
        target: expect.objectContaining({
          accountId: "work",
        }),
      })
    );
  });

  it("passes account-scoped context into getUser hooks", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.assign(Object.create(SignalService.prototype), {
      defaultAccountId: "personal",
      clients: new Map([
        ["personal", {}],
        ["work", {}],
      ]),
      getConnectorUser: vi.fn(async () => null),
    }) as SignalService & {
      getConnectorUser: ReturnType<typeof vi.fn>;
    };

    SignalService.registerSendHandlers(runtime, service);
    const workRegistration = vi
      .mocked(runtime.registerMessageConnector)
      .mock.calls.map((call) => call[0])
      .find((registration) => registration.accountId === "work");

    await workRegistration?.getUser?.(runtime, { query: "ari" });

    expect(service.getConnectorUser).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        query: "ari",
        target: expect.objectContaining({
          source: "signal",
          accountId: "work",
        }),
      })
    );
  });

  it("uses message metadata to react when timestamp and author are omitted", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(),
      getMemoryById: vi.fn(async () => ({
        id: "message-1" as UUID,
        createdAt: 1780000000000,
        metadata: {
          messageIdFull: "1780000001234",
          sender: { id: "+15557654321" },
        },
      })),
    } as unknown as IAgentRuntime;
    const service = Object.create(SignalService.prototype) as SignalService;
    const sendReactionSpy = vi.spyOn(service, "sendReaction").mockResolvedValue();

    await service.reactConnectorMessage(runtime, {
      target: { source: "signal", accountId: "work", channelId: "+15551234567" } as TargetInfo,
      messageId: "message-1",
      emoji: "ok",
    });

    expect(sendReactionSpy).toHaveBeenCalledWith(
      "+15551234567",
      "ok",
      1780000001234,
      "+15557654321",
      "work"
    );
  });

  it("rejects reactions missing a recipient or recoverable message target", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(),
      getMemoryById: vi.fn(async () => null),
    } as unknown as IAgentRuntime;
    const service = Object.create(SignalService.prototype) as SignalService;
    const sendReactionSpy = vi.spyOn(service, "sendReaction").mockResolvedValue();

    await expect(
      service.reactConnectorMessage(runtime, {
        target: { source: "signal" } as TargetInfo,
        emoji: "ok",
        targetTimestamp: 1780000001234,
        targetAuthor: "+15557654321",
      })
    ).rejects.toThrow("Signal reaction requires a target recipient or room.");

    await expect(
      service.reactConnectorMessage(runtime, {
        target: { source: "signal", channelId: "+15551234567" } as TargetInfo,
        messageId: "missing-message",
        emoji: "ok",
      })
    ).rejects.toThrow("Signal reaction requires emoji, targetTimestamp, and targetAuthor.");
    expect(sendReactionSpy).not.toHaveBeenCalled();
  });

  it("skips hostile envelope payloads instead of throwing", () => {
    for (const raw of [
      { envelope: null },
      { envelope: [] },
      { envelope: "not-an-envelope" },
      { envelope: { sourceNumber: "+15551234567", dataMessage: { message: "missing timestamp" } } },
      { envelope: { timestamp: 1780000000000, dataMessage: { message: "missing sender" } } },
    ]) {
      expect(SignalService.unwrapEnvelope(raw)).toBeNull();
    }
  });

  it("unwraps envelope messages while dropping malformed nested fields", () => {
    expect(
      SignalService.unwrapEnvelope({
        envelope: {
          source: "uuid-1",
          sourceNumber: "+15551234567",
          timestamp: 1780000000000,
          dataMessage: {
            message: "hello",
            attachments: "not-an-array",
            groupInfo: "not-a-group",
            viewOnce: "true",
          },
        },
      })
    ).toMatchObject({
      sender: "+15551234567",
      senderUuid: "uuid-1",
      timestamp: 1780000000000,
      message: "hello",
      attachments: [],
      groupId: undefined,
      viewOnce: false,
    });
  });
});
