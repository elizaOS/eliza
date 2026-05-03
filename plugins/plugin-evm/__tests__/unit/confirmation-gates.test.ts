import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { mainnet } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { transferAction } from "../../actions/transfer";

const mocks = vi.hoisted(() => ({
  initWalletProvider: vi.fn(),
  sendTransaction: vi.fn(),
}));

vi.mock("../../providers/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/wallet")>();
  return {
    ...actual,
    initWalletProvider: mocks.initWalletProvider,
  };
});

const transferXml = `<response>
  <fromChain>mainnet</fromChain>
  <toAddress>0x1111111111111111111111111111111111111111</toAddress>
  <amount>0.1</amount>
  <data>0x</data>
</response>`;

function createRuntime(): IAgentRuntime {
  const state = { values: {}, data: { providers: {} } } as State;
  return {
    agentId: "test-agent",
    composeState: vi.fn(async () => state),
    useModel: vi.fn(async () => transferXml),
    getSetting: vi.fn(),
  } as unknown as IAgentRuntime;
}

function createMessage(): Memory {
  return {
    id: "message-id",
    entityId: "entity-id",
    roomId: "room-id",
    agentId: "test-agent",
    content: {
      text: "Transfer 0.1 ETH to 0x1111111111111111111111111111111111111111",
    },
  } as unknown as Memory;
}

function createWalletProvider() {
  return {
    chains: { mainnet },
    getSupportedChains: vi.fn(() => ["mainnet"]),
    getWalletBalances: vi.fn(async () => ({ mainnet: "1" })),
    getChainConfigs: vi.fn(() => mainnet),
    getWalletClient: vi.fn(() => ({
      account: {
        address: "0x2222222222222222222222222222222222222222",
        type: "local",
      },
      sendTransaction: mocks.sendTransaction,
    })),
  };
}

describe("EVM transaction confirmation gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initWalletProvider.mockResolvedValue(createWalletProvider());
    mocks.sendTransaction.mockResolvedValue(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("previews transfers without submitting when confirmed is absent", async () => {
    const callback = vi.fn(async () => []);

    const result = await transferAction.handler(
      createRuntime(),
      createMessage(),
      undefined,
      {},
      callback as HandlerCallback
    );

    expect(result.success).toBe(false);
    expect(result.data?.requiresConfirmation).toBe(true);
    expect(result.data?.preview).toContain("Review EVM transfer");
    expect(result.data?.confirmation).toMatchObject({
      actionName: transferAction.name,
      confirmed: false,
      parameters: {
        fromChain: "mainnet",
        toAddress: "0x1111111111111111111111111111111111111111",
        amount: "0.1",
        confirmed: true,
      },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("confirmed: true"),
      })
    );
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
  });

  it("submits transfers when confirmed is true", async () => {
    const result = await transferAction.handler(createRuntime(), createMessage(), undefined, {
      confirmed: true,
    });

    expect(result.success).toBe(true);
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      actionName: "EVM_TRANSFER_TOKENS",
      transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chain: "mainnet",
    });
  });
});
