import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPositionsAction } from "../actions/getPositions";
import { initializeClobClientWithCreds } from "../utils/clobClient";

vi.mock("../utils/clobClient", () => ({
  initializeClobClientWithCreds: vi.fn(),
}));

vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

function createRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  const secrets = { ...settings };
  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: {
      name: "Test Agent",
      bio: ["Test"],
      system: "Test",
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      plugins: [],
      secrets,
      settings: {},
      style: { all: [], chat: [], post: [] },
    },
    getSetting: vi.fn((key: string) => secrets[key]),
    setSetting: vi.fn((key: string, value: string) => {
      secrets[key] = value;
    }),
    getService: vi.fn(),
    registerService: vi.fn(),
    useModel: vi.fn(),
    emitEvent: vi.fn(),
    composeState: vi.fn(),
    updateRecentMessageState: vi.fn(),
  } as IAgentRuntime;
}

describe("getPositionsAction", () => {
  let runtime: IAgentRuntime;
  let testMessage: Memory;
  let testState: State;
  let callback: HandlerCallback;

  beforeEach(() => {
    runtime = createRuntime({
      CLOB_API_URL: "https://clob.polymarket.com",
      POLYMARKET_PRIVATE_KEY: "0xabc",
      CLOB_API_KEY: "key",
      CLOB_API_SECRET: "secret",
      CLOB_API_PASSPHRASE: "pass",
    });

    testMessage = {
      id: "test-id" as `${string}-${string}-${string}-${string}-${string}`,
      content: { text: "Show positions" },
      userId: "user-id" as `${string}-${string}-${string}-${string}-${string}`,
      roomId: "room-id" as `${string}-${string}-${string}-${string}-${string}`,
      agentId: runtime.agentId,
      createdAt: Date.now(),
    } as Memory;

    testState = {} as State;
    callback = vi.fn();
  });

  it("validates required credentials", async () => {
    const valid = await getPositionsAction.validate(runtime);
    expect(valid).toBe(true);

    const invalidRuntime = createRuntime({
      CLOB_API_URL: "https://clob.polymarket.com",
      POLYMARKET_PRIVATE_KEY: "0xabc",
      CLOB_API_KEY: undefined,
    });
    const invalid = await getPositionsAction.validate(invalidRuntime);
    expect(invalid).toBe(false);
  });

  it("builds positions from trade history", async () => {
    const mockClient = {
      getTradesPaginated: vi.fn().mockResolvedValue({
        trades: [
          {
            market: "m1",
            asset_id: "a1",
            side: "BUY",
            price: "0.4",
            size: "10",
          },
          {
            market: "m1",
            asset_id: "a1",
            side: "SELL",
            price: "0.6",
            size: "5",
          },
        ],
        next_cursor: "",
      }),
      getOrderBook: vi.fn().mockResolvedValue({
        bids: [{ price: "0.55" }],
        asks: [{ price: "0.65" }],
      }),
    };

    vi.mocked(initializeClobClientWithCreds).mockResolvedValue(mockClient);

    const result = await getPositionsAction.handler(
      runtime,
      testMessage,
      testState,
      { parameters: { limit: 50 } },
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.data?.positionsCount).toBe(1);
    expect(result.data?.positions?.[0]?.asset_id).toBe("a1");
    expect(callback).toHaveBeenCalled();
  });
});
