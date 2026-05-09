import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MatrixService } from "../service.js";

describe("Matrix message connector", () => {
  it("registers connector metadata and routes sends through Matrix rooms", async () => {
    const runtime = {
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getSetting: vi.fn((key: string) => (key === "MATRIX_DEFAULT_ACCOUNT_ID" ? "work" : null)),
      character: { settings: {} },
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.create(MatrixService.prototype) as MatrixService;
    (service as { settings: { accountId: string } }).settings = { accountId: "work" };
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
      expect.objectContaining({ accountId: "work", roomId: "!room:matrix.org" })
    );
  });

  it("registers account-scoped connectors and routes through the requested account", async () => {
    const runtime = {
      registerMessageConnector: vi.fn(),
      registerSendHandler: vi.fn(),
      getSetting: vi.fn(),
      character: { settings: {} },
      getRoom: vi.fn(),
    } as IAgentRuntime;
    const service = Object.create(MatrixService.prototype) as MatrixService;
    const states = new Map([
      [
        "work",
        {
          accountId: "work",
          settings: { accountId: "work" },
          client: {},
          connected: true,
          syncing: true,
        },
      ],
      [
        "personal",
        {
          accountId: "personal",
          settings: { accountId: "personal" },
          client: {},
          connected: true,
          syncing: true,
        },
      ],
    ]);
    (service as { states: typeof states; defaultAccountId: string }).states = states;
    (service as { states: typeof states; defaultAccountId: string }).defaultAccountId =
      "work";
    const sendMessageSpy = vi
      .spyOn(service, "sendMessage")
      .mockResolvedValue({ success: true, roomId: "!personal:matrix.org" });

    MatrixService.registerSendHandlers(runtime, service, "work");
    MatrixService.registerSendHandlers(runtime, service, "personal");

    expect(runtime.registerMessageConnector).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(runtime.registerMessageConnector)
        .mock.calls.map(([registration]) => registration.accountId)
    ).toEqual(["work", "personal"]);

    const personalRegistration = vi.mocked(runtime.registerMessageConnector).mock.calls[1][0];
    await personalRegistration.sendHandler(
      runtime,
      { source: "matrix", accountId: "personal", channelId: "!personal:matrix.org" } as TargetInfo,
      { text: "hi" } as Content
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ accountId: "personal", roomId: "!personal:matrix.org" })
    );
  });
});
