/**
 * Regression coverage for `MutualStakeEscrow.create()` vault-address
 * resolution. The system under test is the real SDK class; only the viem
 * public/wallet clients are stubbed at the RPC boundary. VaultCreated logs are
 * built with viem's real `encodeEventLog` so the class must genuinely decode
 * them. Guards the money-path invariant that `create()` returns the vault the
 * mined transaction actually deployed (the receipt's VaultCreated event),
 * never a post-mine re-simulation that describes a different, hypothetical
 * deployment.
 */

import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hash,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutualStakeEscrow } from "./MutualStakeEscrow.js";
import type { CreateEscrowParams } from "./types.js";

vi.mock("@elizaos/core", async () => {
  return await import("../../__tests__/core-vitest-mock.js");
});

const VaultCreatedEventAbi = [
  {
    name: "VaultCreated",
    type: "event",
    inputs: [
      { name: "vault", type: "address", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "paymentAmount", type: "uint256", indexed: false },
      { name: "buyerStake", type: "uint256", indexed: false },
      { name: "sellerStake", type: "uint256", indexed: false },
      { name: "verifier", type: "address", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
  },
] as const;

const FACTORY_ADDRESS: Address = "0xFAc00000000000000000000000000000000Face1";
const BUYER: Address = "0x1111111111111111111111111111111111111111";
const SELLER: Address = "0x2222222222222222222222222222222222222222";
const TOKEN: Address = "0x3333333333333333333333333333333333333333";
const VERIFIER: Address = "0x4444444444444444444444444444444444444444";
const UNRELATED_CONTRACT: Address =
  "0x9999999999999999999999999999999999999999";

// The vault the mined transaction actually deployed.
const DEPLOYED_VAULT: Address = "0xAAaA000000000000000000000000000000000001";
// The address a post-mine re-simulation (eth_call against advanced state)
// would return — a DIFFERENT, hypothetical next deployment.
const RESIMULATED_VAULT: Address = "0xBbbb000000000000000000000000000000000002";

const TX_HASH: Hash =
  "0xdead00000000000000000000000000000000000000000000000000000000beef";

const CREATE_PARAMS: CreateEscrowParams = {
  seller: SELLER,
  paymentAmount: 1_000_000n,
  buyerStake: 100_000n,
  sellerStake: 100_000n,
  verifier: VERIFIER,
  challengeWindow: 86_400,
  deadline: 1_900_000_000,
  token: TOKEN,
};

function vaultCreatedLog(vault: Address, emitter: Address): Log {
  const topics = encodeEventTopics({
    abi: VaultCreatedEventAbi,
    eventName: "VaultCreated",
    args: { vault, buyer: BUYER, seller: SELLER },
  });
  const data = encodeAbiParameters(
    [
      { name: "token", type: "address" },
      { name: "paymentAmount", type: "uint256" },
      { name: "buyerStake", type: "uint256" },
      { name: "sellerStake", type: "uint256" },
      { name: "verifier", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    [
      TOKEN,
      CREATE_PARAMS.paymentAmount,
      CREATE_PARAMS.buyerStake,
      CREATE_PARAMS.sellerStake,
      VERIFIER,
      BigInt(CREATE_PARAMS.deadline),
    ],
  );
  return {
    address: emitter,
    topics,
    data,
    blockNumber: 100n,
    blockHash: `0x${"1".repeat(64)}` as Hash,
    logIndex: 0,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    removed: false,
  };
}

function makeEscrow(logs: Log[]): {
  escrow: MutualStakeEscrow;
  readContract: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
} {
  const writeContract = vi.fn().mockResolvedValue(TX_HASH);
  // If create() ever re-simulates via eth_call it returns the WRONG address.
  const readContract = vi.fn().mockResolvedValue(RESIMULATED_VAULT);
  const waitForTransactionReceipt = vi
    .fn()
    .mockResolvedValue({ logs, transactionHash: TX_HASH, status: "success" });

  const publicClient = {
    waitForTransactionReceipt,
    readContract,
  } as unknown as PublicClient;

  const walletClient = {
    account: { address: BUYER },
    chain: undefined,
    writeContract,
  } as unknown as WalletClient;

  const escrow = new MutualStakeEscrow({
    publicClient,
    walletClient,
    factoryAddress: FACTORY_ADDRESS,
    chainId: 8453,
  });

  return { escrow, readContract, writeContract };
}

describe("MutualStakeEscrow.create vault-address resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the vault from the receipt's VaultCreated event, not the re-simulated address", async () => {
    const { escrow, readContract } = makeEscrow([
      vaultCreatedLog(DEPLOYED_VAULT, FACTORY_ADDRESS),
    ]);

    const result = await escrow.create(CREATE_PARAMS);

    expect(result.address).toBe(DEPLOYED_VAULT);
    expect(result.address).not.toBe(RESIMULATED_VAULT);
    // The fragile post-mine createEscrow re-simulation must be gone.
    expect(readContract).not.toHaveBeenCalled();
  });

  it("surfaces the factory transaction hash in the result", async () => {
    const { escrow } = makeEscrow([
      vaultCreatedLog(DEPLOYED_VAULT, FACTORY_ADDRESS),
    ]);

    const result = await escrow.create(CREATE_PARAMS);

    expect(result.txHash).toBe(TX_HASH);
  });

  it("throws a typed error when the receipt carries no VaultCreated event instead of fabricating an address", async () => {
    const { escrow, readContract } = makeEscrow([]);

    await expect(escrow.create(CREATE_PARAMS)).rejects.toMatchObject({
      code: "ESCROW_VAULT_CREATED_EVENT_MISSING",
    });
    expect(readContract).not.toHaveBeenCalled();
  });

  it("ignores VaultCreated logs emitted by an unrelated contract address", async () => {
    // Only an impostor VaultCreated (from another contract) is present.
    const { escrow } = makeEscrow([
      vaultCreatedLog(RESIMULATED_VAULT, UNRELATED_CONTRACT),
    ]);

    await expect(escrow.create(CREATE_PARAMS)).rejects.toMatchObject({
      code: "ESCROW_VAULT_CREATED_EVENT_MISSING",
    });
  });

  it("selects only the factory's VaultCreated log when impostor logs are interleaved", async () => {
    const { escrow } = makeEscrow([
      vaultCreatedLog(RESIMULATED_VAULT, UNRELATED_CONTRACT),
      vaultCreatedLog(DEPLOYED_VAULT, FACTORY_ADDRESS),
    ]);

    const result = await escrow.create(CREATE_PARAMS);

    expect(result.address).toBe(DEPLOYED_VAULT);
  });
});
