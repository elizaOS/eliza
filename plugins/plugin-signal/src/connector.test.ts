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
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ timestamp: 123 });

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

    expect(sendMessageSpy).toHaveBeenCalledWith("+15551234567", "hello", { record: false });
  });
});
