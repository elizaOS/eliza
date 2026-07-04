/**
 * Verifies the Matrix message connector's read/target-resolution path against a
 * mocked runtime — no live homeserver. Locks that `read_channel` reaches the
 * live read via a Matrix target carrying only `channelId`.
 */
import type { Content, IAgentRuntime, Memory, TargetInfo } from "@elizaos/core";
import { createUniqueUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MatrixService } from "../service.js";

type QueryContext = { runtime: IAgentRuntime; target?: TargetInfo };
type ReadParams = { target?: TargetInfo; limit?: number; query?: string };

// The canonical `read_channel "<room>"` path resolves a Matrix target that
// carries the raw room id ONLY in `channelId` (no core `roomId` UUID). These
// tests lock that the connector still reaches the live read instead of gating
// it behind a field Matrix targets never set.
function memory(id: string, text: string, createdAt: number): Memory {
  return {
    id: createUniqueUuid({} as IAgentRuntime, id),
    entityId: createUniqueUuid({} as IAgentRuntime, `entity:${id}`),
    agentId: createUniqueUuid({} as IAgentRuntime, "agent"),
    roomId: createUniqueUuid({} as IAgentRuntime, "room"),
    content: { text, source: "matrix" },
    createdAt,
  } as Memory;
}

function registerAndGetConnector(service: MatrixService) {
  const runtime = {
    registerMessageConnector: vi.fn(),
    registerSendHandler: vi.fn(),
    getSetting: vi.fn(() => null),
    character: { settings: {} },
    getRoom: vi.fn(),
    getMemories: vi.fn().mockResolvedValue([]),
  } as unknown as IAgentRuntime;
  MatrixService.registerSendHandlers(runtime, service, "work");
  const registration = vi.mocked(runtime.registerMessageConnector).mock.calls[0][0];
  return { runtime, registration };
}

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
    (service as { states: typeof states; defaultAccountId: string }).defaultAccountId = "work";
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

describe("Matrix connector read path (channelId-only targets)", () => {
  function createService() {
    const service = Object.create(MatrixService.prototype) as MatrixService;
    (service as { settings: { accountId: string } }).settings = { accountId: "work" };
    return service;
  }

  // A realistic resolved Matrix target from the canonical read_channel path:
  // source + accountId + channelId (raw matrix id), and NO target.roomId UUID.
  const channelOnlyTarget: TargetInfo = {
    source: "matrix",
    accountId: "work",
    channelId: "!abc:server",
  } as TargetInfo;

  it("fetchMessages reaches getRoomMessages for a channelId-only target", async () => {
    const service = createService();
    const live = [memory("$2", "newer", 200), memory("$1", "older", 100)];
    const getRoomMessages = vi.spyOn(service, "getRoomMessages").mockResolvedValue(live);
    const { runtime, registration } = registerAndGetConnector(service);

    const result = await registration.fetchMessages?.(
      { runtime } as QueryContext,
      { target: channelOnlyTarget, limit: 50 } as ReadParams
    );

    expect(getRoomMessages).toHaveBeenCalledWith("!abc:server", 50, "work");
    expect(result).toEqual(live);
    // The dead getRoom-gated branch must not run for a channelId-only target.
    expect(runtime.getRoom).not.toHaveBeenCalled();
  });

  it("searchMessages reaches getRoomMessages for a channelId-only target", async () => {
    const service = createService();
    const live = [memory("$2", "deploy failed", 200), memory("$1", "all green", 100)];
    const getRoomMessages = vi.spyOn(service, "getRoomMessages").mockResolvedValue(live);
    const { runtime, registration } = registerAndGetConnector(service);

    const result = await registration.searchMessages?.(
      { runtime } as QueryContext,
      { target: channelOnlyTarget, limit: 50, query: "deploy" } as ReadParams & { query: string }
    );

    // scanLimit is max(limit, 100).
    expect(getRoomMessages).toHaveBeenCalledWith("!abc:server", 100, "work");
    expect(result?.map((m) => m.content.text)).toEqual(["deploy failed"]);
    expect(runtime.getRoom).not.toHaveBeenCalled();
  });

  it("falls back to stored memories keyed by the core UUID derived from the raw matrix id", async () => {
    const service = createService();
    // Live timeline empty -> the stored-memory fallback must key by
    // createUniqueUuid(runtime, "!abc:server"), matching how inbound Matrix
    // memories are stored (matrixMessageToMemory).
    vi.spyOn(service, "getRoomMessages").mockResolvedValue([]);
    const { runtime, registration } = registerAndGetConnector(service);
    const stored = [memory("$s", "stored", 50)];
    vi.mocked(runtime.getMemories).mockResolvedValue(stored);

    const result = await registration.fetchMessages?.(
      { runtime } as QueryContext,
      { target: channelOnlyTarget, limit: 50 } as ReadParams
    );

    expect(runtime.getMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: "messages",
        roomId: createUniqueUuid(runtime, "!abc:server"),
        limit: 50,
      })
    );
    expect(result).toEqual(stored);
  });

  it("surfaces the encrypted placeholder end-to-end through fetchMessages", async () => {
    const service = createService();
    // Room timeline holds one undecryptable m.room.encrypted event. The real
    // getRoomMessages converts it to the placeholder memory; drive it through
    // the live SDK client (not a getRoomMessages spy) to lock the full path.
    const encryptedEvent = {
      getContent: vi.fn(() => ({})),
      getType: vi.fn(() => "m.room.encrypted"),
      isDecryptionFailure: vi.fn(() => false),
      getSender: vi.fn(() => "@alice:server"),
      getRoomId: vi.fn(() => "!abc:server"),
      getId: vi.fn(() => "$enc"),
      getTs: vi.fn(() => 999),
    };
    const room = {
      getJoinedMemberCount: vi.fn(() => 3),
      getMember: vi.fn(() => ({ name: "Alice" })),
      getLiveTimeline: vi.fn(() => ({ getEvents: vi.fn(() => [encryptedEvent]) })),
    };
    const runtimeForService = {
      agentId: createUniqueUuid({} as IAgentRuntime, "agent"),
    } as unknown as IAgentRuntime;
    Object.assign(service as unknown as { runtime: IAgentRuntime; defaultAccountId: string }, {
      runtime: runtimeForService,
      defaultAccountId: "work",
    });
    (service as unknown as { states: Map<string, { accountId: string; client: unknown }> }).states =
      new Map([
        [
          "work",
          {
            accountId: "work",
            client: { getRoom: vi.fn(() => room) },
            connected: true,
            syncing: true,
          },
        ],
      ]) as never;

    const { runtime, registration } = registerAndGetConnector(service);
    const result = await registration.fetchMessages?.(
      { runtime } as QueryContext,
      { target: channelOnlyTarget, limit: 50 } as ReadParams
    );

    expect(result).toHaveLength(1);
    expect(result?.[0].content.text).toContain("end-to-end encrypted message");
    expect(result?.[0].content.name).toBe("Alice");
  });
});

describe("Matrix connector account roles (agent vs personal)", () => {
  function runtimeWith(matrix: Record<string, unknown>): IAgentRuntime {
    const env: Record<string, string> = {
      MATRIX_HOMESERVER: "https://hs.example",
      MATRIX_USER_ID: "@bot:hs.example",
      MATRIX_ACCESS_TOKEN: "tok",
    };
    return {
      character: { settings: { matrix } },
      getSetting: (k: string) => env[k] ?? null,
    } as unknown as IAgentRuntime;
  }

  it("exposes the agent's own account as an open AGENT account", async () => {
    const { createMatrixConnectorAccountProvider } = await import(
      "../connector-account-provider.js"
    );
    const provider = createMatrixConnectorAccountProvider(runtimeWith({}));
    const accounts = await provider.listAccounts({} as never);
    const def = accounts[0];
    expect(def.role).toBe("AGENT");
    expect(def.accessGate).toBe("open");
    expect(def.metadata?.personal).toBe(false);
  });

  it("exposes a personal account as an owner_binding-gated OWNER account", async () => {
    const { createMatrixConnectorAccountProvider } = await import(
      "../connector-account-provider.js"
    );
    const provider = createMatrixConnectorAccountProvider(
      runtimeWith({
        accounts: {
          nubs: {
            homeserver: "https://hs.example",
            userId: "@nubs:hs.example",
            accessToken: "tok2",
            personal: true,
          },
        },
      })
    );
    const accounts = await provider.listAccounts({} as never);
    const personal = accounts.find((a) => a.displayHandle === "@nubs:hs.example");
    expect(personal?.role).toBe("OWNER");
    expect(personal?.accessGate).toBe("owner_binding");
    expect(personal?.purpose).toContain("reading");
  });
});
