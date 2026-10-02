/**
 * Browser Solana cluster must fail closed on invalid values.
 *
 * POST /api/wallet/browser-solana-transaction previously mapped any
 * unrecognized `cluster` to mainnet, so a typo such as "mainent" would
 * silently sign and (with broadcast=true) broadcast on mainnet. Missing or
 * blank clusters still default to mainnet; valid values pass through
 * case-insensitively; anything else is rejected before key use or network.
 * Exercises the real route handler; the web3 boundary is mocked and
 * broadcast stays false so no network is touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleWalletRoutes,
  type WalletRouteContext,
} from "./wallet-routes.ts";

vi.mock("@solana/web3.js", () => ({
  Keypair: {
    fromSeed: () => ({}),
  },
  VersionedTransaction: {
    deserialize: () => ({
      sign: () => {},
      serialize: () => new Uint8Array([9, 9, 9]),
    }),
  },
  Transaction: {
    from: () => ({
      partialSign: () => {},
      serialize: () => new Uint8Array([9, 9, 9]),
    }),
  },
  Connection: class {
    async sendRawTransaction(): Promise<string> {
      return "mock-signature";
    }
  },
}));

const TX_BASE64 = Buffer.from("test-tx-bytes").toString("base64");
const SOLANA_KEY = `[${Array(32).fill(1).join(",")}]`;

function buildCtx(body: unknown) {
  const res: { statusCode?: number; body?: unknown } = {};
  const ctx = {
    req: { headers: {} },
    res,
    method: "POST",
    pathname: "/api/wallet/browser-solana-transaction",
    config: {},
    saveConfig: vi.fn(),
    readJsonBody: vi.fn(async () => body),
    json(target: typeof res, data: unknown, status = 200) {
      target.statusCode = status;
      target.body = data;
    },
    error(target: typeof res, message: string, status = 400) {
      target.statusCode = status;
      target.body = { error: message };
    },
    deps: {
      deriveSolanaAddress: () => "TestSolanaAddress",
    },
  } as unknown as WalletRouteContext;
  return { ctx, res };
}

async function postCluster(
  cluster: unknown,
  extra: Record<string, unknown> = {},
) {
  const { ctx, res } = buildCtx({
    transactionBase64: TX_BASE64,
    broadcast: false,
    ...(cluster === undefined ? {} : { cluster }),
    ...extra,
  });
  await expect(handleWalletRoutes(ctx)).resolves.toBe(true);
  return res;
}

beforeEach(() => {
  process.env.SOLANA_PRIVATE_KEY = SOLANA_KEY;
});

describe("POST /api/wallet/browser-solana-transaction cluster validation", () => {
  it("defaults missing or blank cluster to mainnet", async () => {
    for (const cluster of [undefined, null, "   ", ""]) {
      const res = await postCluster(cluster);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ cluster: "mainnet" });
    }
  });

  it("accepts valid clusters case-insensitively", async () => {
    const cases: Array<[unknown, string]> = [
      ["mainnet", "mainnet"],
      ["devnet", "devnet"],
      ["testnet", "testnet"],
      [" TestNet ", "testnet"],
      ["DEVNET", "devnet"],
      [" MainNet ", "mainnet"],
    ];
    for (const [input, expected] of cases) {
      const res = await postCluster(input);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ cluster: expected });
    }
  });

  it("rejects invalid clusters instead of routing to mainnet", async () => {
    for (const cluster of [
      "mainent",
      "devnet2",
      "MAIN_NET",
      123,
      true,
      { cluster: "mainnet" },
    ]) {
      const res = await postCluster(cluster);
      expect(res.statusCode).not.toBe(200);
      const message =
        typeof res.body === "object" && res.body !== null && "error" in res.body
          ? String((res.body as { error: unknown }).error)
          : "";
      expect(message).toContain("Invalid Solana cluster");
    }
  });
});
