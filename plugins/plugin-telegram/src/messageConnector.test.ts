import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { TelegramService } from "./service";

function createRuntime() {
  return {
    agentId: "agent-1",
    character: { name: "Agent One" },
    registerMessageConnector: vi.fn(),
    registerSendHandler: vi.fn(),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn().mockResolvedValue(null),
    getMemories: vi.fn().mockResolvedValue([]),
    getEntityById: vi.fn().mockResolvedValue(null),
  } as unknown as IAgentRuntime & {
    registerMessageConnector: ReturnType<typeof vi.fn>;
    registerSendHandler: ReturnType<typeof vi.fn>;
  };
}

function createTelegramService(
  overrides: Record<string, unknown>,
): TelegramService {
  return Object.assign(
    Object.create(TelegramService.prototype) as TelegramService,
    overrides,
  );
}

describe("Telegram message connector adapter", () => {
  it("registers connector metadata with chat and thread support", () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      bot: {},
      messageManager: {},
      handleSendMessage: vi.fn(),
      resolveConnectorTargets: vi.fn(),
      listRecentConnectorTargets: vi.fn(),
      listConnectorRooms: vi.fn(),
      getConnectorChatContext: vi.fn(),
      getConnectorUserContext: vi.fn(),
    });

    TelegramService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector.mock.calls[0][0]).toMatchObject({
      source: "telegram",
      label: "Telegram",
      capabilities: expect.arrayContaining([
        "send_message",
        "resolve_targets",
        "chat_context",
        "user_context",
      ]),
      supportedTargetKinds: ["channel", "group", "thread", "user"],
      contexts: ["social", "connectors"],
    });
  });

  it("registers account-scoped and legacy connector routes", () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      bot: {},
      handleSendMessage: vi.fn(),
      accountStates: new Map([
        [
          "acct-a",
          {
            accountId: "acct-a",
            account: { accountId: "acct-a", name: "A" },
          },
        ],
        [
          "acct-b",
          {
            accountId: "acct-b",
            account: { accountId: "acct-b", name: "B" },
          },
        ],
      ]),
      defaultAccountId: "acct-a",
    });

    TelegramService.registerSendHandlers(runtime, service);

    const registrations = runtime.registerMessageConnector.mock.calls.map(
      (call) => call[0],
    );
    expect(registrations.map((registration) => registration.accountId)).toEqual(
      [undefined, "acct-a", "acct-b"],
    );
    expect(registrations[2]).toMatchObject({
      source: "telegram",
      accountId: "acct-b",
      account: { accountId: "acct-b" },
      metadata: { accountId: "acct-b" },
    });
  });

  it("parses forum-topic channel IDs for unified sends", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue([]);
    const service = createTelegramService({
      bot: {},
      messageManager: { sendMessage },
    });

    await service.handleSendMessage(
      runtime,
      { source: "telegram", channelId: "-1001234567890-42" },
      { text: "hello" },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "-1001234567890",
      { text: "hello", metadata: { accountId: "default" } },
      undefined,
      42,
    );
  });

  it("routes outbound sends through the requested account manager", async () => {
    const runtime = createRuntime();
    const managerA = { sendMessage: vi.fn().mockResolvedValue([]) };
    const managerB = { sendMessage: vi.fn().mockResolvedValue([]) };
    const service = createTelegramService({
      bot: {},
      messageManager: managerA,
      defaultAccountId: "acct-a",
      accountStates: new Map([
        ["acct-a", { accountId: "acct-a", messageManager: managerA, bot: {} }],
        ["acct-b", { accountId: "acct-b", messageManager: managerB, bot: {} }],
      ]),
    });

    await service.handleSendMessage(
      runtime,
      { source: "telegram", accountId: "acct-b", channelId: "-100123" },
      { text: "hello" },
    );

    expect(managerA.sendMessage).not.toHaveBeenCalled();
    expect(managerB.sendMessage).toHaveBeenCalledWith(
      "-100123",
      { text: "hello", metadata: { accountId: "acct-b" } },
      undefined,
      undefined,
    );
  });

  it("resolves known chats into connector targets", async () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      runtime,
      bot: null,
      knownChats: new Map([
        [
          "-100123",
          {
            id: -100123,
            type: "supergroup",
            title: "Ops Room",
            is_forum: true,
          },
        ],
      ]),
    });

    const targets = await service.resolveConnectorTargets("ops", { runtime });

    expect(targets[0]).toMatchObject({
      label: "Ops Room",
      kind: "group",
      target: { source: "telegram", channelId: "-100123" },
    });
  });

  it("does not stamp known chats onto the wrong account", async () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      runtime,
      bot: null,
      defaultAccountId: "acct-a",
      accountStates: new Map([
        ["acct-a", { accountId: "acct-a" }],
        ["acct-b", { accountId: "acct-b" }],
      ]),
      knownChats: new Map([
        [
          "acct-a:-100111",
          {
            id: -100111,
            type: "supergroup",
            title: "A Room",
          },
        ],
        [
          "acct-b:-100222",
          {
            id: -100222,
            type: "supergroup",
            title: "B Room",
          },
        ],
      ]),
    });

    const targets = await service.listConnectorRooms({ runtime });

    expect(
      targets.map((target) => ({
        accountId: target.target.accountId,
        channelId: target.target.channelId,
      })),
    ).toEqual([
      { accountId: "acct-a", channelId: "-100111" },
      { accountId: "acct-b", channelId: "-100222" },
    ]);
  });

  it("does not use legacy unscoped known chats for non-default accounts", async () => {
    const runtime = createRuntime();
    const service = createTelegramService({
      runtime,
      bot: null,
      defaultAccountId: "acct-a",
      accountStates: new Map([
        ["acct-a", { accountId: "acct-a" }],
        ["acct-b", { accountId: "acct-b" }],
      ]),
      knownChats: new Map([
        [
          "-100111",
          {
            id: -100111,
            type: "supergroup",
            title: "Legacy Default Room",
          },
        ],
      ]),
    });

    const context = {
      runtime,
      accountId: "acct-b",
      target: { source: "telegram", accountId: "acct-b" },
    };
    const result = await service.getConnectorChatContext(
      { source: "telegram", accountId: "acct-b", channelId: "-100111" },
      context,
    );

    expect(result?.summary).toBeUndefined();
    expect(result?.label).toBe("-100111");
    expect(result?.metadata).toMatchObject({ accountId: "acct-b" });
  });

  it("starts non-default accounts when the default account has no token", async () => {
    const runtime = {
      ...createRuntime(),
      character: {
        name: "Agent One",
        settings: {
          telegram: {
            accounts: {
              default: { enabled: true },
              "acct-b": { enabled: true, botToken: "token-b" },
            },
          },
        },
      },
      getSetting: vi.fn().mockReturnValue(undefined),
    } as unknown as IAgentRuntime;
    const initializeBot = vi
      .spyOn(
        TelegramService.prototype as unknown as {
          initializeBot: (state: unknown) => Promise<void>;
        },
        "initializeBot",
      )
      .mockResolvedValue(undefined);
    const fakeBot = {
      botInfo: { username: "acct_b_bot" },
      launch: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      telegram: { getMe: vi.fn().mockResolvedValue({ id: 2 }) },
      use: vi.fn(),
    };
    const createAccountRuntime = vi
      .spyOn(
        TelegramService.prototype as unknown as {
          createAccountRuntime: (account: unknown) => unknown;
        },
        "createAccountRuntime",
      )
      .mockImplementation((account: unknown) => {
        const scopedAccount = account as { accountId: string };
        return {
          accountId: scopedAccount.accountId,
          account,
          bot: fakeBot,
          messageManager: { sendMessage: vi.fn() },
        };
      });

    const service = await TelegramService.start(runtime);

    expect(createAccountRuntime).toHaveBeenCalledTimes(1);
    expect(createAccountRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-b", botToken: "token-b" }),
    );
    expect(initializeBot).toHaveBeenCalledTimes(1);
    expect(
      Array.from(
        (
          service as unknown as {
            accountStates: Map<string, unknown>;
          }
        ).accountStates.keys(),
      ),
    ).toEqual(["acct-b"]);

    initializeBot.mockRestore();
    createAccountRuntime.mockRestore();
  });
});
