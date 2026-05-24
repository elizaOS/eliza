import type { Vault } from "@elizaos/vault";
import { ethers } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeeBootGate } from "./tee-boot-gate.ts";
import {
  clearTeeBootGateState,
  setTeeBootGateState,
} from "./tee-boot-gate-state.ts";
import { VaultSignerBackend } from "./vault-signer-backend.ts";

// Deterministic test key (not a real funded account).
const TEST_KEY = `0x${"1".repeat(64)}`;
const EXPECTED_ADDRESS = new ethers.Wallet(TEST_KEY).address;

const blockingGate: TeeBootGate = {
  policy: undefined,
  teeConfigured: true,
  required: true,
  productionProfile: false,
  secretsEnabled: false,
};

function vaultWith(key: string): Vault {
  const stored = JSON.stringify({
    chain: "evm",
    address: EXPECTED_ADDRESS,
    privateKey: key,
    lastModified: Date.now(),
  });
  return {
    reveal: vi.fn(async () => stored),
    get: vi.fn(async () => stored),
    set: vi.fn(),
    setReference: vi.fn(),
    has: vi.fn(async () => true),
    remove: vi.fn(),
    list: vi.fn(async () => []),
    describe: vi.fn(async () => null),
    stats: vi.fn(),
  } as unknown as Vault;
}

describe("VaultSignerBackend", () => {
  afterEach(() => {
    clearTeeBootGateState();
    vi.restoreAllMocks();
  });

  it("derives the address from the vault-stored EVM key", async () => {
    const backend = new VaultSignerBackend({
      vault: vaultWith(TEST_KEY),
      agentId: "agent-1",
    });
    await expect(backend.getAddress()).resolves.toBe(EXPECTED_ADDRESS);
  });

  it("produces a verifiable transaction signature", async () => {
    const backend = new VaultSignerBackend({
      vault: vaultWith(TEST_KEY),
      agentId: "agent-1",
    });
    const signed = await backend.signTransaction({
      to: "0x0000000000000000000000000000000000000002",
      value: "0",
      data: "0x",
      chainId: 1,
      nonce: 0,
      gasLimit: "21000",
      maxFeePerGas: "1000000000",
      maxPriorityFeePerGas: "1000000000",
    });
    const parsed = ethers.Transaction.from(signed);
    expect(parsed.from).toBe(EXPECTED_ADDRESS);
    expect(parsed.to).toBe("0x0000000000000000000000000000000000000002");
  });

  it("fails closed when the TEE boot gate blocks secrets (no key reveal)", async () => {
    setTeeBootGateState(blockingGate);
    const vault = vaultWith(TEST_KEY);
    const backend = new VaultSignerBackend({ vault, agentId: "agent-1" });
    await expect(backend.getAddress()).rejects.toThrow(/TeeBootGate/);
    expect(vault.reveal).not.toHaveBeenCalled();
  });

  it("rejects an empty agentId at construction", () => {
    expect(
      () =>
        new VaultSignerBackend({ vault: vaultWith(TEST_KEY), agentId: "  " }),
    ).toThrow(/agentId/);
  });
});
