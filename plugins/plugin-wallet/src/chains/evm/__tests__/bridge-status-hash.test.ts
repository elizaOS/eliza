/**
 * BridgeAction.bridge tracks the bridge transaction, not an ERC-20 approval.
 *
 * @lifi/sdk 3.16.3 runs checkAllowance before it creates the CROSS_CHAIN
 * process (EVMStepExecutor.ts), and records the approve transaction hash on a
 * TOKEN_ALLOWANCE process (checkAllowance.ts waitForApprovalTransaction). The
 * route below has that shape. Li.Fi's status API knows only the bridge hash.
 */

import { arbitrum, base } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APPROVE_HASH = `0x${"a".repeat(64)}`;
const BRIDGE_HASH = `0x${"b".repeat(64)}`;
const USDT_BASE = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const USDT_ARB = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const statusQueries: string[] = [];

vi.mock("@lifi/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lifi/sdk")>();
  const route = {
    id: "route-1",
    steps: [
      {
        tool: "stargate",
        execution: {
          status: "DONE",
          process: [
            { type: "TOKEN_ALLOWANCE", status: "DONE", txHash: APPROVE_HASH },
            { type: "CROSS_CHAIN", status: "DONE", txHash: BRIDGE_HASH },
            { type: "RECEIVING_CHAIN", status: "DONE", txHash: `0x${"c".repeat(64)}` },
          ],
        },
      },
    ],
  };
  return {
    ...actual,
    // No network: the SDK config would preload chains from li.quest.
    createConfig: vi.fn(),
    EVM: vi.fn(() => ({})),
    getRoutes: vi.fn(async () => ({ routes: [route] })),
    // Like the SDK, report route progress through the update hook.
    executeRoute: vi.fn(
      async (_route: unknown, options?: { updateRouteHook?: (updated: unknown) => void }) => {
        options?.updateRouteHook?.(route);
        return route;
      }
    ),
    getStatus: vi.fn(async ({ txHash }: { txHash: string }) => {
      statusQueries.push(txHash);
      if (txHash !== BRIDGE_HASH) {
        throw new Error("Not a bridge transaction");
      }
      return { status: "DONE", substatus: "COMPLETED" };
    }),
  };
});

const { BridgeAction } = await import("../bridge-router");

function walletProvider() {
  const chains = { base, arbitrum };
  return {
    chains,
    getChainConfigs: (name: keyof typeof chains) => chains[name],
    getWalletClient: () => ({
      getAddresses: async () => ["0x1111111111111111111111111111111111111111"],
    }),
    getPublicClient: () => ({ readContract: async () => 6 }),
  };
}

describe("BridgeAction.bridge status tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    statusQueries.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a completed bridge that needed a token approval as done, with the bridge hash", async () => {
    const action = new BridgeAction(walletProvider() as never);
    const settled = action
      .bridge({
        fromChain: "base",
        toChain: "arbitrum",
        fromToken: USDT_BASE,
        toToken: USDT_ARB,
        amount: "100",
      } as never)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);
    const result = await settled;

    expect(statusQueries[0]).toBe(BRIDGE_HASH);
    expect(result).toMatchObject({ ok: true, value: { hash: BRIDGE_HASH } });
  });
});
