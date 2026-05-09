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
    } as unknown as IAgentRuntime;
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

  it("threads target accountId into sends and returned memories", async () => {
    const roomId = "room-1" as UUID;
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(async () => ({ id: roomId, source: "signal", channelId: "+15551234567" })),
    } as unknown as IAgentRuntime;
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
    } as unknown as IAgentRuntime;
    const service = Object.assign(Object.create(SignalService.prototype), {
      defaultAccountId: "personal",
      clients: new Map([
        ["personal", {}],
        ["work", {}],
      ]),
    }) as SignalService;
    const sendMessageSpy = vi.spyOn(service, "sendMessage").mockResolvedValue({ timestamp: 789 });

    SignalService.registerSendHandlers(runtime, service);
    const registrations = vi.mocked(runtime.registerMessageConnector).mock.calls.map(
      (call) => call[0]
    );
    const workRegistration = registrations.find((registration) => registration.accountId === "work");

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
    } as unknown as IAgentRuntime;
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
});
