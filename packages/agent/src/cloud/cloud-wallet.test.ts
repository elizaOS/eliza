/**
 * Tests for cloud-wallet.ts — client-address key mgmt + idempotent provisioning.
 */

import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ElizaCloudClient } from "./bridge-client";
import {
  __resetCloudWalletModuleForTests,
  CloudWalletFlagDisabledError,
  getOrCreateClientAddressKey,
  MILADY_CLOUD_CLIENT_ADDRESS_KEY_ENV,
  persistCloudWalletCache,
  provisionCloudWallets,
  provisionCloudWalletsBestEffort,
} from "./cloud-wallet";

// ---------------------------------------------------------------------------
// Test HTTP server — counts calls per route/chain so we can assert
// idempotency and single-flight behavior.
// ---------------------------------------------------------------------------

let server: http.Server;
let serverPort: number;

let provisionCalls: Array<{ chainType: string; clientAddress: string }> = [];
let getAgentCallsByChain: Record<string, number> = {};
/** If true, the agent-wallet GET returns 200 with no wallet — forcing provision. */
let simulateMissingWallet = true;
/** When simulateMissingWallet=false, respond with this address per chain. */
let existingEvmAddress: string | null = null;
let existingSolanaAddress: string | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const chain = requestUrl.searchParams.get("chain") ?? "any";

    // GET /api/v1/milady/agents/:agentId/wallet
    if (
      req.method === "GET" &&
      requestUrl.pathname.includes("/milady/agents/") &&
      requestUrl.pathname.endsWith("/wallet")
    ) {
      getAgentCallsByChain[chain] = (getAgentCallsByChain[chain] ?? 0) + 1;
      if (simulateMissingWallet) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            success: true,
            data: {
              walletAddress: null,
              walletAddresses: {},
              walletProvider: null,
              walletStatus: "none",
              balance: null,
              chain: null,
            },
          }),
        );
        return;
      }
      const walletAddresses = {
        ...(existingEvmAddress ? { evm: existingEvmAddress } : {}),
        ...(existingSolanaAddress ? { solana: existingSolanaAddress } : {}),
      };
      const walletAddress =
        chain === "solana"
          ? existingSolanaAddress
          : (existingEvmAddress ??
            existingSolanaAddress ??
            "0xexisting0000000000000000000000000000000000");
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          success: true,
          data: {
            agentId: "agent-1",
            walletAddress,
            walletAddresses,
            walletProvider: "steward",
            walletStatus: "active",
            balance: "0",
          },
        }),
      );
      return;
    }

    // POST /api/v1/user/wallets/provision
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/v1/user/wallets/provision"
    ) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        provisionCalls.push(parsed);
        const walletId = `wallet-${parsed.chainType}-${provisionCalls.length}`;
        const address =
          parsed.chainType === "evm"
            ? "0xcafecafecafecafecafecafecafecafecafecafe"
            : "So1anaAddr1111111111111111111111111111111";
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            success: true,
            data: {
              id: walletId,
              address,
              chainType: parsed.chainType,
              clientAddress: parsed.clientAddress,
              provider: "privy",
            },
          }),
        );
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  process.env.ENABLE_CLOUD_WALLET = "1";
  __resetCloudWalletModuleForTests();
  provisionCalls = [];
  getAgentCallsByChain = {};
  simulateMissingWallet = true;
  existingEvmAddress = null;
  existingSolanaAddress = null;
});

afterEach(() => {
  delete process.env.ENABLE_CLOUD_WALLET;
});

function bridge(): ElizaCloudClient {
  return new ElizaCloudClient(`http://127.0.0.1:${serverPort}`, "test-api-key");
}

// ---------------------------------------------------------------------------
// getOrCreateClientAddressKey
// ---------------------------------------------------------------------------

describe("getOrCreateClientAddressKey", () => {
  let tmpStateDir: string;

  beforeEach(async () => {
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "milady-ccak-"));
  });

  afterEach(async () => {
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  it("mints a fresh key and persists it to process.env AND config.env on disk", async () => {
    expect(process.env[MILADY_CLOUD_CLIENT_ADDRESS_KEY_ENV]).toBeUndefined();

    const result = await getOrCreateClientAddressKey({ stateDir: tmpStateDir });

    expect(result.minted).toBe(true);
    expect(result.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(process.env[MILADY_CLOUD_CLIENT_ADDRESS_KEY_ENV]).toBe(
      result.privateKey,
    );

    // Derived address matches
    const derived = privateKeyToAccount(result.privateKey).address;
    expect(result.address).toBe(derived);

    // Disk: config.env written with the key so it survives restart.
    const contents = await fs.readFile(
      path.join(tmpStateDir, "config.env"),
      "utf8",
    );
    expect(contents).toContain(
      `${MILADY_CLOUD_CLIENT_ADDRESS_KEY_ENV}=${result.privateKey}`,
    );
  });

  it("short-circuits when a key already exists in env (no disk write)", async () => {
    const first = await getOrCreateClientAddressKey({ stateDir: tmpStateDir });
    expect(first.minted).toBe(true);

    // Delete config.env so we can prove the short-circuit does NOT touch disk
    await fs.rm(path.join(tmpStateDir, "config.env"), { force: true });

    const second = await getOrCreateClientAddressKey({ stateDir: tmpStateDir });
    expect(second.minted).toBe(false);
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.address).toBe(first.address);

    // No disk write on the short-circuit path.
    await expect(
      fs.stat(path.join(tmpStateDir, "config.env")),
    ).rejects.toThrow();
  });

  it("throws when the flag is disabled", async () => {
    delete process.env.ENABLE_CLOUD_WALLET;
    await expect(
      getOrCreateClientAddressKey({ stateDir: tmpStateDir }),
    ).rejects.toBeInstanceOf(CloudWalletFlagDisabledError);
  });

  it("rejects malformed env values", async () => {
    process.env[MILADY_CLOUD_CLIENT_ADDRESS_KEY_ENV] = "not-hex";
    await expect(
      getOrCreateClientAddressKey({ stateDir: tmpStateDir }),
    ).rejects.toThrow(/Malformed/);
  });
});

// ---------------------------------------------------------------------------
// provisionCloudWallets
// ---------------------------------------------------------------------------

describe("provisionCloudWallets", () => {
  it("provisions both chains when no wallet exists", async () => {
    const d = await provisionCloudWallets(bridge(), {
      agentId: "agent-1",
      clientAddress: "0xclient",
    });

    expect(d.evm.chainType).toBe("evm");
    expect(d.solana.chainType).toBe("solana");
    expect(provisionCalls.map((c) => c.chainType).sort()).toEqual([
      "evm",
      "solana",
    ]);
  });

  it("reuses existing cloud wallets before attempting provision", async () => {
    simulateMissingWallet = false;
    existingEvmAddress = "0xcafecafecafecafecafecafecafecafecafecafe";
    existingSolanaAddress = "So11111111111111111111111111111111111111112";

    const d = await provisionCloudWallets(bridge(), {
      agentId: "agent-1",
      clientAddress: "0xclient",
    });

    expect(d.evm.walletAddress).toBe(existingEvmAddress);
    expect(d.solana.walletAddress).toBe(existingSolanaAddress);
    expect(provisionCalls).toHaveLength(0);
    expect(getAgentCallsByChain).toEqual({ evm: 1, solana: 1 });
  });

  it("single-flight: concurrent calls for the same agent/chain share one provision", async () => {
    const [a, b] = await Promise.all([
      provisionCloudWallets(bridge(), {
        agentId: "agent-1",
        clientAddress: "0xclient",
        chains: ["evm"],
      }),
      provisionCloudWallets(bridge(), {
        agentId: "agent-1",
        clientAddress: "0xclient",
        chains: ["evm"],
      }),
    ]);

    expect(a.evm.walletAddress).toBe(b.evm.walletAddress);
    // Exactly one provision call for EVM despite two concurrent callers
    expect(provisionCalls.filter((c) => c.chainType === "evm")).toHaveLength(1);
  });

  it("returns partial results when one chain fails validation", async () => {
    const partialBridge = {
      getAgentWallet: vi.fn(async (_agentId: string, chain: string) => {
        throw new Error(`Agent has no cloud ${chain} wallet provisioned`);
      }),
      provisionWallet: vi.fn(async (input: { chainType: string }) => {
        if (input.chainType === "solana") {
          throw new Error("Validation error: Invalid Solana address");
        }

        return {
          walletId: "wallet-evm-1",
          address: "0xcafecafecafecafecafecafecafecafecafecafe",
          chainType: "evm" as const,
          provider: "privy" as const,
        };
      }),
    } as unknown as ElizaCloudClient;

    const result = await provisionCloudWalletsBestEffort(partialBridge, {
      agentId: "agent-1",
      clientAddress: "0xclient",
    });

    expect(result.descriptors.evm?.walletAddress).toBe(
      "0xcafecafecafecafecafecafecafecafecafecafe",
    );
    expect(result.descriptors.solana).toBeUndefined();
    expect(result.warnings).toEqual([
      "Cloud solana wallet import failed: Validation error: Invalid Solana address",
    ]);
  });

  it("throws when the flag is disabled", async () => {
    delete process.env.ENABLE_CLOUD_WALLET;
    await expect(
      provisionCloudWallets(bridge(), { agentId: "x", clientAddress: "0x1" }),
    ).rejects.toBeInstanceOf(CloudWalletFlagDisabledError);
  });
});

// ---------------------------------------------------------------------------
// persistCloudWalletCache
// ---------------------------------------------------------------------------

describe("persistCloudWalletCache", () => {
  it("writes descriptors into config.wallet.cloud without clobbering siblings", () => {
    const config: Record<string, unknown> = {
      wallet: {
        primary: { evm: "local" },
        cloud: { solana: { agentWalletId: "old" } },
      },
    };

    persistCloudWalletCache(config, {
      evm: {
        agentWalletId: "w1",
        walletAddress: "0xaddr",
        walletProvider: "privy",
        chainType: "evm",
      },
    });

    const wallet = config.wallet as {
      primary: { evm: string };
      cloud: {
        evm?: { walletAddress: string };
        solana: { agentWalletId: string };
      };
    };
    expect(wallet.primary.evm).toBe("local");
    expect(wallet.cloud.evm?.walletAddress).toBe("0xaddr");
    expect(wallet.cloud.solana.agentWalletId).toBe("old");
  });

  it("creates wallet.cloud when missing", () => {
    const config: Record<string, unknown> = {};
    persistCloudWalletCache(config, {
      evm: {
        agentWalletId: "w1",
        walletAddress: "0xaddr",
        walletProvider: "steward",
        chainType: "evm",
      },
    });
    expect(config.wallet).toBeDefined();
  });

  it("throws when the flag is disabled", () => {
    delete process.env.ENABLE_CLOUD_WALLET;
    expect(() => persistCloudWalletCache({}, {})).toThrow(
      CloudWalletFlagDisabledError,
    );
  });
});
