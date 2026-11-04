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
// Per-test Li.Fi behavior: how status reads and route execution end.
const lifi = vi.hoisted(() => ({
  status: "DONE" as "DONE" | "PENDING" | "FAILED" | "THROW",
  execute: "OK" as "OK" | "THROW_AFTER_BRIDGE" | "THROW_AFTER_APPROVAL",
  // A route to run instead of the default one, and the tools status reads got.
  route: null as unknown,
  tools: [] as string[],
}));

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
        if (lifi.route) {
          options?.updateRouteHook?.(lifi.route);
          return lifi.route;
        }
        if (lifi.execute === "THROW_AFTER_APPROVAL") {
          const [approval] = route.steps[0].execution.process;
          options?.updateRouteHook?.({
            ...route,
            steps: [{ ...route.steps[0], execution: { status: "PENDING", process: [approval] } }],
          });
          throw new Error("User rejected the bridge transaction");
        }
        options?.updateRouteHook?.(route);
        if (lifi.execute === "THROW_AFTER_BRIDGE") {
          throw new Error("Failed to fetch receipt: 502 Bad Gateway");
        }
        return route;
      }
    ),
    getStatus: vi.fn(async ({ txHash, bridge }: { txHash: string; bridge?: string }) => {
      statusQueries.push(txHash);
      lifi.tools.push(String(bridge));
      if (txHash !== BRIDGE_HASH) {
        throw new Error("Not a bridge transaction");
      }
      if (lifi.status === "THROW") throw new Error("429 Too Many Requests");
      if (lifi.status === "FAILED") return { status: "FAILED", substatus: "REFUNDED" };
      if (lifi.status === "PENDING") return { status: "PENDING" };
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
    lifi.status = "DONE";
    lifi.execute = "OK";
    lifi.route = null;
    lifi.tools.length = 0;
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

  async function bridge() {
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
    return settled;
  }

  // After the bridge transaction is sent, "failed" invites a second bridge.
  it("reports a sent bridge whose status read failed as unconfirmed, with the bridge hash", async () => {
    lifi.status = "THROW";
    expect(await bridge()).toMatchObject({
      ok: true,
      value: { hash: BRIDGE_HASH, confirmationStatus: "unconfirmed" },
    });
  });

  it("reports a sent bridge whose status polling timed out as unconfirmed", async () => {
    lifi.status = "PENDING";
    expect(await bridge()).toMatchObject({
      ok: true,
      value: { hash: BRIDGE_HASH, confirmationStatus: "unconfirmed" },
    });
  });

  it("reports a bridge whose route execution threw after the bridge hash as unconfirmed", async () => {
    lifi.execute = "THROW_AFTER_BRIDGE";
    expect(await bridge()).toMatchObject({
      ok: true,
      value: { hash: BRIDGE_HASH, confirmationStatus: "unconfirmed" },
    });
  });

  it("still fails when only the token approval was sent", async () => {
    lifi.execute = "THROW_AFTER_APPROVAL";
    const result = await bridge();
    expect(result.ok).toBe(false);
    expect(statusQueries).toEqual([]);
  });

  it("still fails when Li.Fi reports the bridge as failed", async () => {
    lifi.status = "FAILED";
    const result = await bridge();
    expect(result.ok).toBe(false);
  });

  // chusmias258-dev on #38695: an approval hash is never the bridge.
  it("fails a route that finished with only the token approval hash, without polling it", async () => {
    lifi.route = {
      id: "route-approval-only",
      steps: [
        {
          tool: "stargate",
          execution: {
            status: "DONE",
            process: [{ type: "TOKEN_ALLOWANCE", status: "DONE", txHash: APPROVE_HASH }],
          },
        },
      ],
    };
    lifi.status = "THROW";
    const result = await bridge();
    expect(result.ok).toBe(false);
    expect(statusQueries).toEqual([]);
  });

  it("polls the bridge step's hash and tool when a swap step comes first", async () => {
    const SWAP_HASH = `0x${"d".repeat(64)}`;
    lifi.route = {
      id: "route-swap-then-bridge",
      steps: [
        {
          tool: "uniswap",
          execution: {
            status: "DONE",
            process: [{ type: "SWAP", status: "DONE", txHash: SWAP_HASH }],
          },
        },
        {
          tool: "stargate",
          execution: {
            status: "DONE",
            process: [{ type: "CROSS_CHAIN", status: "DONE", txHash: BRIDGE_HASH }],
          },
        },
      ],
    };
    const result = await bridge();
    expect(statusQueries[0]).toBe(BRIDGE_HASH);
    expect(lifi.tools[0]).toBe("stargate");
    expect(result).toMatchObject({ ok: true, value: { hash: BRIDGE_HASH } });
  });
});
