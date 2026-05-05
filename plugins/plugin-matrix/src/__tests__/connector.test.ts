import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MatrixService } from "../service.js";

describe("Matrix message connector", () => {
  it("registers connector metadata and routes sends through Matrix rooms", async () => {
    const runtime = {
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
    } as unknown as IAgentRuntime;
    const service = Object.create(MatrixService.prototype) as MatrixService;
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, roomId: "!room:matrix.org" });

    MatrixService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "matrix",
        label: "Matrix",
        capabilities: expect.arrayContaining(["send_message", "list_rooms"]),
        supportedTargetKinds: expect.arrayContaining(["room", "thread"]),
      })
    );

    const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];
    await registration.sendHandler(
      runtime,
      { source: "matrix", channelId: "!room:matrix.org" } as TargetInfo,
      { text: "hello" } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ roomId: "!room:matrix.org" })
    );
  });
});
