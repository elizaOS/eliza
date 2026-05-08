import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MatrixService } from "../service.js";

describe("Matrix message connector", () => {
  it("registers connector metadata and routes sends through Matrix rooms", async () => {
    const runtime = {
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getSetting: vi.fn((key: string) =>
        key === "MATRIX_DEFAULT_ACCOUNT_ID" ? "work" : null
      ),
      character: { settings: {} },
      getRoom: vi.fn(),
    } as unknown as IAgentRuntime;
    const service = Object.create(MatrixService.prototype) as MatrixService;
    (service as unknown as { settings: { accountId: string } }).settings = { accountId: "work" };
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, roomId: "!room:matrix.org" });

    MatrixService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "matrix",
        accountId: "work",
        label: "Matrix",
        capabilities: expect.arrayContaining(["send_message", "list_rooms"]),
        supportedTargetKinds: expect.arrayContaining(["room", "thread"]),
      })
    );

    const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];
    await registration.sendHandler(
      runtime,
      { source: "matrix", accountId: "work", channelId: "!room:matrix.org" } as TargetInfo,
      { text: "hello" } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ roomId: "!room:matrix.org" })
    );
  });
});
