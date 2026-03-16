import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBalancesAction } from "../actions/getBalances";
import { getWalletAddress, initializeClobClient } from "../utils/clobClient";

vi.mock("../utils/clobClient", () => ({
  initializeClobClient: vi.fn(),
  getWalletAddress: vi.fn(),
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

describe("getBalancesAction", () => {
  let runtime: IAgentRuntime;
  let testMessage: Memory;
  let testState: State;
  let callback: HandlerCallback;

  beforeEach(() => {
    runtime = createRuntime({
      CLOB_API_URL: "https://clob.polymarket.com",
      POLYMARKET_PRIVATE_KEY: "0xabc",
    });

    testMessage = {
      id: "test-id" as `${string}-${string}-${string}-${string}-${string}`,
      content: { text: "Show my balances" },
      userId: "user-id" as `${string}-${string}-${string}-${string}-${string}`,
      roomId: "room-id" as `${string}-${string}-${string}-${string}-${string}`,
      agentId: runtime.agentId,
      createdAt: Date.now(),
    } as Memory;

    testState = {} as State;
    callback = vi.fn();
  });

  it("validates required settings", async () => {
    const valid = await getBalancesAction.validate(runtime);
    expect(valid).toBe(true);

    const invalidRuntime = createRuntime({
      CLOB_API_URL: "https://clob.polymarket.com",
      POLYMARKET_PRIVATE_KEY: undefined,
    });
    const invalid = await getBalancesAction.validate(invalidRuntime);
    expect(invalid).toBe(false);
  });

  it("returns balances for collateral and token IDs", async () => {
    const mockClient = {
      getBalanceAllowance: vi.fn().mockResolvedValue({ balance: "50", allowance: "100" }),
    };

    vi.mocked(initializeClobClient).mockResolvedValue(mockClient);
    vi.mocked(getWalletAddress).mockReturnValue("0xwallet");

    const result = await getBalancesAction.handler(
      runtime,
      testMessage,
      testState,
      { parameters: { tokenIds: ["token-1"], includeCollateral: true } },
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.data?.collateralBalance?.balance).toBe("50");
    expect(result.data?.tokenBalances?.["token-1"]?.balance).toBe("50");
    expect(callback).toHaveBeenCalled();
  });
});
