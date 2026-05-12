import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type {
  CreateEscrowParams,
  EscrowCreated,
  EscrowDetails,
  TxResult,
} from "./types.js";
import { TaskStatus } from "./types.js";
import {
  encodeOptimisticVerifierData,
  resolveVerifierAddress,
} from "./verifiers.js";

// ─── ABIs ────────────────────────────────────────────────────────────────────

const StakeVaultFactoryAbi = [
  {
    name: "createEscrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_buyer", type: "address" },
      { name: "_seller", type: "address" },
      { name: "_token", type: "address" },
      { name: "_paymentAmount", type: "uint256" },
      { name: "_buyerStake", type: "uint256" },
      { name: "_sellerStake", type: "uint256" },
      { name: "_verifier", type: "address" },
      { name: "_verifierData", type: "bytes" },
      { name: "_deadline", type: "uint256" },
      { name: "_challengeWindow", type: "uint256" },
    ],
    outputs: [{ name: "vault", type: "address" }],
  },
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

const StakeVaultAbi = [
  {
    name: "fund",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "accept",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "fulfill",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "proof", type: "bytes" }],
    outputs: [],
  },
  {
    name: "verify",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "challenge",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "evidence", type: "bytes" }],
    outputs: [],
  },
  {
    name: "resolve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "sellerWins", type: "bool" }],
    outputs: [],
  },
  {
    name: "cancel",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "reclaimExpired",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "getEscrowDetails",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_buyer", type: "address" },
      { name: "_seller", type: "address" },
      { name: "_token", type: "address" },
      { name: "_paymentAmount", type: "uint256" },
      { name: "_buyerStake", type: "uint256" },
      { name: "_sellerStake", type: "uint256" },
      { name: "_verifier", type: "address" },
      { name: "_deadline", type: "uint256" },
      { name: "_challengeWindow", type: "uint256" },
      { name: "_status", type: "uint8" },
      { name: "_fulfilledAt", type: "uint256" },
    ],
  },
  {
    name: "status",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

function toTaskStatus(value: unknown): TaskStatus {
  const status = Number(value);
  if (!Number.isInteger(status) || !(status in TaskStatus)) {
    throw new Error(`Invalid escrow task status: ${String(value)}`);
  }
  return status as TaskStatus;
}

const ERC20ApproveAbi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Base USDC address */
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * MutualStakeEscrow — SDK class for creating and managing mutual-stake escrow vaults
 *
 * Wraps the StakeVault and StakeVaultFactory contracts with a clean TypeScript API.
 * Both buyer and seller deposit collateral, ensuring aligned incentives.
 */
export class MutualStakeEscrow {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private factoryAddress: Address;
  private chainId: number;

  constructor(params: {
    publicClient: PublicClient;
    walletClient: WalletClient;
    factoryAddress: Address;
    chainId: number;
  }) {
    this.publicClient = params.publicClient;
    this.walletClient = params.walletClient;
    this.factoryAddress = params.factoryAddress;
    this.chainId = params.chainId;
  }

  /**
   * Create a new escrow vault via the factory
   * @param params - Escrow creation parameters
   * @returns The deployed vault address and transaction hash
   */
  async create(params: CreateEscrowParams): Promise<EscrowCreated> {
    const account = this.walletClient.account;
    if (!account) throw new Error("Wallet client must have an account");

    const token = params.token ?? BASE_USDC;
    const verifierAddress = resolveVerifierAddress(
      params.verifier,
      this.chainId,
    );
    const verifierData = params.verifierData ?? encodeOptimisticVerifierData();

    const txHash = await this.walletClient.writeContract({
      address: this.factoryAddress,
      abi: StakeVaultFactoryAbi,
      functionName: "createEscrow",
      args: [
        account.address,
        params.seller,
        token,
        params.paymentAmount,
        params.buyerStake,
        params.sellerStake,
        verifierAddress,
        verifierData,
        BigInt(params.deadline),
        BigInt(params.challengeWindow),
      ],
      account,
      chain: this.walletClient.chain,
    });

    await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    // Read vault address from return data via simulation
    // (VaultCreated event parsing reserved for future use)
    const vaultAddress = (await this.publicClient.readContract({
      address: this.factoryAddress,
      abi: StakeVaultFactoryAbi,
      functionName: "createEscrow",
      args: [
        account.address,
        params.seller,
        token,
        params.paymentAmount,
        params.buyerStake,
        params.sellerStake,
        verifierAddress,
        verifierData,
        BigInt(params.deadline),
        BigInt(params.challengeWindow),
      ],
    })) as Address;

    return { address: vaultAddress, txHash };
  }

  /**
   * Fund an escrow as buyer (deposits payment + buyerStake)
   * @param vaultAddress - Address of the StakeVault
   * @param approveAmount - Total amount to approve (payment + buyerStake)
   */
  async fund(vaultAddress: Address, approveAmount: bigint): Promise<TxResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error("Wallet client must have an account");

    const details = await this.getDetails(vaultAddress);

    // Approve token transfer
    await this.walletClient.writeContract({
      address: details.token,
      abi: ERC20ApproveAbi,
      functionName: "approve",
      args: [vaultAddress, approveAmount],
      account,
      chain: this.walletClient.chain,
    });

    const txHash = await this.walletClient.writeContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "fund",
      args: [],
      account,
      chain: this.walletClient.chain,
    });

    return { txHash };
  }

  /**
   * Accept an escrow as seller (deposits sellerStake)
   * @param vaultAddress - Address of the StakeVault
   */
  async accept(vaultAddress: Address): Promise<TxResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error("Wallet client must have an account");

    const details = await this.getDetails(vaultAddress);

    // Approve seller stake transfer
    await this.walletClient.writeContract({
      address: details.token,
      abi: ERC20ApproveAbi,
      functionName: "approve",
      args: [vaultAddress, details.sellerStake],
      account,
      chain: this.walletClient.chain,
    });

    const txHash = await this.walletClient.writeContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "accept",
      args: [],
      account,
      chain: this.walletClient.chain,
    });

    return { txHash };
  }

  /**
   * Submit fulfillment proof as seller
   * @param vaultAddress - Address of the StakeVault
   * @param proof - Completion proof bytes
   */
  async fulfill(vaultAddress: Address, proof: Hex): Promise<TxResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error("Wallet client must have an account");

    const txHash = await this.walletClient.writeContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "fulfill",
      args: [proof],
      account,
      chain: this.walletClient.chain,
    });

    return { txHash };
  }

  /**
   * Verify completion after challenge window (anyone can call)
   * @param vaultAddress - Address of the StakeVault
   */
  async verify(vaultAddress: Address): Promise<TxResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error("Wallet client must have an account");

    const txHash = await this.walletClient.writeContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "verify",
      args: [],
      account,
      chain: this.walletClient.chain,
    });

    return { txHash };
  }

  /**
   * Challenge a fulfillment as buyer
   * @param vaultAddress - Address of the StakeVault
   * @param evidence - Challenge evidence bytes
   */
  async challenge(vaultAddress: Address, evidence: Hex): Promise<TxResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error("Wallet client must have an account");

    const txHash = await this.walletClient.writeContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "challenge",
      args: [evidence],
      account,
      chain: this.walletClient.chain,
    });

    return { txHash };
  }

  /**
   * Cancel escrow before seller accepts (buyer only)
   * @param vaultAddress - Address of the StakeVault
   */
  async cancel(vaultAddress: Address): Promise<TxResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error("Wallet client must have an account");

    const txHash = await this.walletClient.writeContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "cancel",
      args: [],
      account,
      chain: this.walletClient.chain,
    });

    return { txHash };
  }

  /**
   * Reclaim funds after deadline expiry
   * @param vaultAddress - Address of the StakeVault
   */
  async reclaimExpired(vaultAddress: Address): Promise<TxResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error("Wallet client must have an account");

    const txHash = await this.walletClient.writeContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "reclaimExpired",
      args: [],
      account,
      chain: this.walletClient.chain,
    });

    return { txHash };
  }

  /**
   * Get full escrow details from on-chain
   * @param vaultAddress - Address of the StakeVault
   */
  async getDetails(vaultAddress: Address): Promise<EscrowDetails> {
    const result = await this.publicClient.readContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "getEscrowDetails",
      args: [],
    });

    const [
      buyer,
      seller,
      token,
      paymentAmount,
      buyerStake,
      sellerStake,
      verifier,
      deadline,
      challengeWindow,
      statusNum,
      fulfilledAt,
    ] = result as [
      Address,
      Address,
      Address,
      bigint,
      bigint,
      bigint,
      Address,
      bigint,
      bigint,
      number,
      bigint,
    ];

    return {
      buyer,
      seller,
      token,
      paymentAmount,
      buyerStake,
      sellerStake,
      verifier,
      deadline,
      challengeWindow,
      status: statusNum as TaskStatus,
      fulfilledAt,
    };
  }

  /**
   * Get the current status of an escrow
   * @param vaultAddress - Address of the StakeVault
   */
  async getStatus(vaultAddress: Address): Promise<TaskStatus> {
    const result = await this.publicClient.readContract({
      address: vaultAddress,
      abi: StakeVaultAbi,
      functionName: "status",
      args: [],
    });

    return toTaskStatus(result);
  }
}
