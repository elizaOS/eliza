/**
 * Proof-of-control gate for server-wallet provisioning (#10279 #3).
 *
 * Provision is authenticated only by the org's API key, so without a
 * proof-of-control any org could claim an arbitrary `clientAddress` — squatting
 * the globally-unique-per-chain row (a permanent DoS for the true key-holder)
 * and capturing that address's RPC routing. `provisionServerWallet` now requires a
 * signature over `buildWalletProvisionChallenge` made with the clientAddress
 * key, and verifies it BEFORE touching Steward or the DB.
 *
 * The signature verification here is REAL viem crypto with real keypairs; only
 * the external Steward client, DB insert, and cache (for nonce replay) are
 * doubled — exactly the seams the gate sits in front of.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildWalletProvisionChallenge } from "@elizaos/cloud-sdk/wallet-provision-challenge";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// --- cache double: in-memory nonce store so replay is deterministic ----------
const nonceStore = new Map<string, string>();
mock.module("../cache/client", () => ({
  cache: {
    isAvailable: () => true,
    setIfNotExists: async (key: string) => {
      if (nonceStore.has(key)) return false;
      nonceStore.set(key, "1");
      return true;
    },
  },
}));

// --- Steward double: records whether provisioning was reached ----------------
const createWallet = mock(async () => ({
  id: "steward-agent-1",
  walletAddress: "0x000000000000000000000000000000000000beef",
}));
mock.module("./steward-client", () => ({
  createStewardClient: mock(async () => ({
    createWallet,
    getAgent: mock(async () => ({
      id: "steward-agent-1",
      walletAddress: "0x000000000000000000000000000000000000beef",
    })),
  })),
}));
mock.module("./steward-tenant-config", () => ({
  resolveStewardTenantCredentials: mock(async () => ({ tenantId: "tenant-1" })),
}));

// --- DB double: db.insert(table).values(data).returning() -> [row] -----------
const insertedRows: Array<Record<string, unknown>> = [];
mock.module("../../db/client", () => ({
  db: {
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => {
          insertedRows.push(data);
          return [{ id: "wallet-row-1", ...data }];
        },
      }),
    }),
  },
}));

const { provisionServerWallet } = await import("./server-wallets");

const SIGNER_KEY = generatePrivateKey();
const signer = privateKeyToAccount(SIGNER_KEY);
const CLIENT_ADDRESS = signer.address;
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function signProof(
  account: ReturnType<typeof privateKeyToAccount>,
  clientAddress: string,
  chainType: "evm" | "solana",
  overrides: { timestamp?: number; nonce?: string } = {},
): Promise<{ signature: `0x${string}`; timestamp: number; nonce: string }> {
  const timestamp = overrides.timestamp ?? Date.now();
  const nonce = overrides.nonce ?? `nonce-${Math.random().toString(16).slice(2)}`;
  const signature = await account.signMessage({
    message: buildWalletProvisionChallenge({
      clientAddress,
      chainType,
      timestamp,
      nonce,
    }),
  });
  return { signature, timestamp, nonce };
}

function provision(
  clientAddress: string,
  controlProof: { signature: `0x${string}`; timestamp: number; nonce: string },
  chainType: "evm" | "solana" = "evm",
) {
  return provisionServerWallet({
    organizationId: ORG,
    userId: USER,
    characterId: null,
    clientAddress,
    chainType,
    controlProof,
  });
}

beforeEach(() => {
  nonceStore.clear();
  insertedRows.length = 0;
  createWallet.mockClear();
});

afterEach(() => {
  createWallet.mockClear();
});

describe("provisionServerWallet — proof-of-control gate", () => {
  test("accepts a valid proof and proceeds to provision", async () => {
    const proof = await signProof(signer, CLIENT_ADDRESS, "evm");
    const record = await provision(CLIENT_ADDRESS, proof);

    expect(record).toBeTruthy();
    // The gate passed → Steward + DB were reached exactly once.
    expect(createWallet).toHaveBeenCalledTimes(1);
    expect(insertedRows.length).toBe(1);
    expect(insertedRows[0]?.client_address).toBe(CLIENT_ADDRESS.toLowerCase());
  });

  test("rejects a proof signed by a DIFFERENT key (the squatting case)", async () => {
    // Attacker claims CLIENT_ADDRESS but signs with their own (other) key.
    const attacker = privateKeyToAccount(generatePrivateKey());
    const forged = await signProof(attacker, CLIENT_ADDRESS, "evm");

    await expect(provision(CLIENT_ADDRESS, forged)).rejects.toMatchObject({
      name: "ProvisionProofInvalidError",
    });
    // Provisioning was never reached — no Steward call, no DB row.
    expect(createWallet).not.toHaveBeenCalled();
    expect(insertedRows.length).toBe(0);
  });

  test("rejects an expired proof (timestamp outside the window)", async () => {
    const stale = await signProof(signer, CLIENT_ADDRESS, "evm", {
      timestamp: Date.now() - 6 * 60 * 1000,
    });
    await expect(provision(CLIENT_ADDRESS, stale)).rejects.toMatchObject({
      name: "ProvisionProofExpiredError",
    });
    expect(createWallet).not.toHaveBeenCalled();
  });

  test("rejects a far-future proof (timestamp outside the window)", async () => {
    const future = await signProof(signer, CLIENT_ADDRESS, "evm", {
      timestamp: Date.now() + 6 * 60 * 1000,
    });
    await expect(provision(CLIENT_ADDRESS, future)).rejects.toMatchObject({
      name: "ProvisionProofExpiredError",
    });
  });

  test("rejects a replayed proof (same nonce twice)", async () => {
    const proof = await signProof(signer, CLIENT_ADDRESS, "evm");

    await expect(provision(CLIENT_ADDRESS, proof)).resolves.toBeTruthy();
    // The identical proof — now a replay — must be rejected.
    await expect(provision(CLIENT_ADDRESS, proof)).rejects.toMatchObject({
      name: "ProvisionProofReplayError",
    });
    // Only the first call provisioned.
    expect(createWallet).toHaveBeenCalledTimes(1);
    expect(insertedRows.length).toBe(1);
  });

  test("rejects when the signed chainType differs from the requested one", async () => {
    // Proof signed for solana, but the request says evm → message mismatch.
    const mismatched = await signProof(signer, CLIENT_ADDRESS, "solana");
    await expect(provision(CLIENT_ADDRESS, mismatched, "evm")).rejects.toMatchObject({
      name: "ProvisionProofInvalidError",
    });
    expect(createWallet).not.toHaveBeenCalled();
  });
});
