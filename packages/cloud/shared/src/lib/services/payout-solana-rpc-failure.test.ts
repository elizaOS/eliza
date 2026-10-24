/**
 * A Solana RPC failure while reading the hot wallet's token account must not be
 * reported as "the payout wallet holds no tokens".
 *
 * `checkSolanaNetwork` folded every `getAccount()` rejection into `null`, so a
 * 429/timeout from the RPC produced the same `status: "no_balance"` as a
 * genuinely missing associated token account. The EVM path in the same service
 * already degrades an unreadable balance read to `not_configured`
 * ("Failed to check balance: …"), and `resolveNetworkStatus` exists precisely to
 * fail closed on a failed check.
 *
 * The two private members are reached through the instance because the public
 * entry point derives the Solana wallet from `SOLANA_PAYOUT_PRIVATE_KEY`, and
 * key decoding is not what this test is about.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { payoutStatusService } from "./payout-status";

type SolanaCheck = (walletAddress: string | null) => Promise<{ status: string; message: string }>;
type NetworkResolution = (
  network: "solana",
  configured: boolean,
  produce: () => Promise<{ status: string; message: string }>,
) => Promise<{ status: string; message: string }>;

const walletAddress = Keypair.generate().publicKey.toBase58();
const savedRpcUrl = process.env.SOLANA_RPC_URL;

let rpcMode: "account_not_found" | "rpc_unavailable" = "account_not_found";
let server: ReturnType<typeof Bun.serve>;
let checkSolanaNetwork: SolanaCheck;
let resolveNetworkStatus: NetworkResolution;

beforeAll(async () => {
  // `bun test` shares one process across files and `payout-hot-wallet-prefix`
  // replaces `./eliza-token-price` with empty token addresses; restore the real
  // module so this file reads the actual mint, not the sibling test's stub.
  mock.restore();

  // Minimal JSON-RPC endpoint: answers `getAccountInfo` with `value: null`
  // (the real "no associated token account" answer) or rejects the request the
  // way an overloaded/rate-limited RPC does.
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (rpcMode === "rpc_unavailable") {
        // A 503 is not retried by @solana/web3.js, so the failure surfaces on
        // the first request instead of after the 429 backoff.
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32005,
              message: "Node is behind",
            },
            id: 1,
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      const body = (await request.json()) as { id?: number };
      return Response.json({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        result: { context: { slot: 1 }, value: null },
      });
    },
  });

  process.env.SOLANA_RPC_URL = `http://127.0.0.1:${server.port}`;

  const service = payoutStatusService as unknown as Record<string, unknown>;
  checkSolanaNetwork = service.checkSolanaNetwork.bind(payoutStatusService) as SolanaCheck;
  resolveNetworkStatus = service.resolveNetworkStatus.bind(
    payoutStatusService,
  ) as NetworkResolution;
});

afterEach(() => {
  rpcMode = "account_not_found";
});

afterAll(() => {
  server?.stop(true);
  if (savedRpcUrl === undefined) delete process.env.SOLANA_RPC_URL;
  else process.env.SOLANA_RPC_URL = savedRpcUrl;
});

describe("solana payout balance read", () => {
  test("a missing associated token account is still no_balance", async () => {
    const network = await checkSolanaNetwork(walletAddress);

    expect(network.status).toBe("no_balance");
    expect(network.message).toBe("Payout wallet token account not found or has no tokens");
  });

  test("an RPC failure is reported as an unreadable check, not an empty wallet", async () => {
    rpcMode = "rpc_unavailable";

    const network = await resolveNetworkStatus("solana", true, () =>
      checkSolanaNetwork(walletAddress),
    );

    expect(network.status).toBe("not_configured");
    expect(network.message).toContain("Status check failed");
    expect(network.message).not.toContain("token account not found");
  });
});
