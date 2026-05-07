import { type IAgentRuntime, type Memory, ServiceType, type State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SOLANA_SERVICE_NAME } from "../constants";
import { allActionDocs } from "../generated/specs/specs";
import { SOLANA_WALLET_COMPAT_SERVICE_NAME, SolanaService, SolanaWalletService } from "../service";
import { executeSwap } from "./swap";
import transferToken from "./transfer";

const RECIPIENT = "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function makeState(): State {
  return {
    values: {},
    data: {
      providers: {
        RECENT_MESSAGES: {
          data: {
            recentMessages: [],
          },
        },
      },
    },
  } as unknown as State;
}

function makeRuntime(modelResponse: string, solanaService: Record<string, unknown>) {
  const runtime = {
    agentId: "agent-id",
    character: { name: "agent" },
    composeState: vi.fn(async () => makeState()),
    getService: vi.fn((name: string) => (name === SOLANA_SERVICE_NAME ? solanaService : null)),
    getServicesByType: vi.fn(() => []),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    },
    useModel: vi.fn(async () => modelResponse),
  };

  return runtime as unknown as IAgentRuntime & {
    composeState: ReturnType<typeof vi.fn>;
    getService: ReturnType<typeof vi.fn>;
    useModel: ReturnType<typeof vi.fn>;
  };
}

describe("Solana service registration", () => {
  it("keeps one public Solana service and moves the wallet wrapper off ServiceType.WALLET", () => {
    expect(SolanaService.serviceType).toBe(SOLANA_SERVICE_NAME);
    expect(SolanaWalletService.serviceType).toBe(SOLANA_WALLET_COMPAT_SERVICE_NAME);
    expect(SolanaWalletService.serviceType).not.toBe(ServiceType.WALLET);
  });
});

describe("Solana generated action specs", () => {
  it("uses a chain-specific swap action spec name", () => {
    const names = allActionDocs.map((doc) => doc.name);

    expect(names).toContain("SOLANA_TRANSFER");
    expect(names).toContain("SOLANA_SWAP");
    expect(names).not.toContain("SWAP");
    expect(names).not.toContain("SWAP_SOLANA");
    expect(names).not.toContain("TRANSFER");
  });
});

describe("Solana transfer action", () => {
  it("keeps the confirmation gate before calling the chain handler", async () => {
    const handleWalletAction = vi.fn();
    const runtime = makeRuntime(
      `tokenAddress: null
recipient: ${RECIPIENT}
amount: 1.5`,
      { handleWalletAction }
    );
    const callback = vi.fn();

    const result = await transferToken.handler(
      runtime,
      { content: { text: `send 1.5 SOL to ${RECIPIENT}` } } as Memory,
      undefined,
      undefined,
      callback
    );

    expect(handleWalletAction).not.toHaveBeenCalled();
    expect(result?.data).toMatchObject({
      requiresConfirmation: true,
      confirmation: {
        actionName: "SOLANA_TRANSFER",
        parameters: {
          confirmed: true,
          tokenAddress: null,
          recipient: RECIPIENT,
          amount: 1.5,
        },
      },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Review Solana transfer before submitting"),
      })
    );
  });

  it("delegates confirmed transfers to SolanaService.handleWalletAction", async () => {
    const handleWalletAction = vi.fn(async () => ({
      success: true,
      signature: "solana-signature",
      dryRun: false,
      kind: "sol",
      amount: "1.5",
      recipient: RECIPIENT,
      tokenAddress: null,
    }));
    const runtime = makeRuntime(
      `tokenAddress: null
recipient: ${RECIPIENT}
amount: 1.5`,
      { handleWalletAction }
    );
    const callback = vi.fn();

    await transferToken.handler(
      runtime,
      { content: { text: `send 1.5 SOL to ${RECIPIENT}` } } as Memory,
      undefined,
      { confirmed: true },
      callback
    );

    expect(handleWalletAction).toHaveBeenCalledWith({
      subaction: "transfer",
      chain: "solana",
      tokenAddress: null,
      recipient: RECIPIENT,
      amount: 1.5,
      mode: "execute",
      dryRun: false,
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          success: true,
          signature: "solana-signature",
        }),
      })
    );
  });
});

describe("Solana swap action", () => {
  it("delegates confirmed swaps to SolanaService.handleWalletAction", async () => {
    const handleWalletAction = vi.fn(async () => ({
      success: true,
      txid: "swap-signature",
      dryRun: false,
      inputTokenCA: "SOL",
      outputTokenCA: USDC_MINT,
      amount: "1.25",
    }));
    const runtime = makeRuntime(
      `inputTokenSymbol: SOL
outputTokenSymbol: USDC
inputTokenCA: null
outputTokenCA: ${USDC_MINT}
amount: 1.25`,
      {
        getCachedData: vi.fn(async () => ({ totalUsd: "0", items: [] })),
        handleWalletAction,
      }
    );
    const callback = vi.fn();

    await executeSwap.handler(
      runtime,
      { content: { text: "swap 1.25 SOL to USDC" } } as Memory,
      undefined,
      { confirmed: true },
      callback
    );

    expect(handleWalletAction).toHaveBeenCalledWith({
      subaction: "swap",
      chain: "solana",
      inputTokenSymbol: "SOL",
      outputTokenSymbol: "USDC",
      inputTokenCA: "SOL",
      outputTokenCA: USDC_MINT,
      amount: 1.25,
      mode: "execute",
      dryRun: false,
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          success: true,
          txid: "swap-signature",
          dryRun: false,
        },
      })
    );
  });
});
