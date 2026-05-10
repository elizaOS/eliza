import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { LineService } from "./service.js";

describe("LINE message connector", () => {
  it("registers connector metadata and routes location sends through the local router", async () => {
    const runtime = {
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.create(LineService.prototype) as LineService;
    const sendLocationSpy = vi
      .spyOn(service, "sendLocationMessage")
      .mockResolvedValue({ success: true, chatId: "C123456789012345678901234567890" });

    LineService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "line",
        label: "LINE",
        capabilities: expect.arrayContaining(["send_message", "send_location"]),
        supportedTargetKinds: expect.arrayContaining(["contact", "group", "room"]),
      })
    );

    const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];
    await registration.sendHandler(
      runtime,
      { source: "line", channelId: "C123456789012345678901234567890" } as TargetInfo,
      {
        text: "Meet here",
        data: {
          line: {
            location: {
              type: "location",
              title: "Tokyo Tower",
              address: "4 Chome-2-8 Shibakoen, Minato City, Tokyo",
              latitude: 35.6586,
              longitude: 139.7454,
            },
          },
        },
      } as Content
    );

    expect(sendLocationSpy).toHaveBeenCalledWith(
      "C123456789012345678901234567890",
      expect.objectContaining({
        title: "Tokyo Tower",
        latitude: 35.6586,
      })
    );
  });
});
