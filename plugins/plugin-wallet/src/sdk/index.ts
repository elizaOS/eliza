import type { JsonValue } from "@elizaos/core";
import {
  type Address,
  type Chain,
  createPublicClient,
  getContract,
  type Hash,
  type Hex,
  http,
  type WalletClient,
} from "viem";
import { arbitrum, base, baseSepolia, mainnet, polygon } from "viem/chains";
import { AgentAccountFactoryV2Abi, AgentAccountV2Abi } from "./abi.js";
import type {
  ActivityEntry,
  BatchTransfer,
  BudgetForecast,
  ExecuteResult,
  PendingTx,
  QueuedEvent,
  WalletHealth,
} from "./types.js";
import {
  NATIVE_TOKEN,
  requireWalletAccount,
  type AgentWallet as Wallet,
} from "./wallet-core.js";

export { AgentAccountFactoryV2Abi, AgentAccountV2Abi } from "./abi.js";
export type {
  ActivityEntry,
  AgentWalletConfig,
  BatchTransfer,
  BudgetForecast,
  BudgetStatus,
  ExecuteResult,
  PendingTx,
  QueuedEvent,
  SpendPolicy,
  WalletHealth,
} from "./types.js";
export {
  agentTransferToken,
  checkBudget,
  createWallet,
  NATIVE_TOKEN,
  requireWalletAccount,
  setSpendPolicy,
} from "./wallet-core.js";
export type {
  X402ClientConfig,
  X402PaymentPayload,
  X402PaymentRequired,
  X402PaymentRequirements,
  X402ResourceInfo,
  X402ServiceBudget,
  X402SettlementResponse,
  X402TransactionLog,
} from "./x402/index.js";
// [MAX-ADDED] x402 protocol support
export {
  createX402Client,
  createX402Fetch,
  DEFAULT_SUPPORTED_NETWORKS,
  USDC_ADDRESSES,
  wrapWithX402,
  X402BudgetExceededError,
  X402BudgetTracker,
  X402Client,
  X402PaymentError,
} from "./x402/index.js";

const CHAINS: Record<string, Chain> = {
  base,
  "base-sepolia": baseSepolia,
  ethereum: mainnet,
  arbitrum,
  polygon,
};

/**
 * Execute a transaction as the agent. If within limits, executes immediately.
 * If over limits, queues for owner approval and returns the pending tx ID.
 */
export async function agentExecute(
  wallet: Wallet,
  params: { to: Address; value?: bigint; data?: Hex },
): Promise<ExecuteResult> {
  const value = params.value ?? 0n;
  const data = params.data ?? "0x";

  const hash = await wallet.contract.write.agentExecute(
    [params.to, value, data],
    {
      value,
      account: requireWalletAccount(wallet.walletClient),
      chain: wallet.chain,
    },
  );

  // Check the tx receipt for TransactionQueued vs TransactionExecuted events
  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });

  // Event topic hash for AgentAccountV2 queue detection
  const QUEUED_TOPIC =
    "0x338e4b9b04df0b67a953d7ea6a7037128b8c6948e3d8c09a9d51a5f5be6c2284";

  const walletAddr = wallet.address.toLowerCase();
  const queuedLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === walletAddr &&
      log.topics[0] === QUEUED_TOPIC,
  );

  const wasExecuted = !queuedLog;

  return {
    executed: wasExecuted,
    txHash: hash,
  };
}

/**
 * Get a pending transaction by ID.
 */
export async function getPendingApprovals(
  wallet: Wallet,
  fromId: bigint = 0n,
  toId?: bigint,
): Promise<PendingTx[]> {
  const maxId = toId ?? (await wallet.contract.read.pendingNonce());
  const results: PendingTx[] = [];

  for (let i = fromId; i < maxId; i++) {
    const [to, value, token, amount, createdAt, executed, cancelled] =
      await wallet.contract.read.getPending([i]);

    if (!executed && !cancelled && createdAt > 0n) {
      results.push({
        txId: i,
        to,
        value,
        data: "0x", // data not returned by getPending view
        token,
        amount,
        createdAt: Number(createdAt),
        executed,
        cancelled,
      });
    }
  }

  return results;
}

/**
 * Approve a pending transaction. Only callable by the NFT owner.
 */
export async function approveTransaction(
  wallet: Wallet,
  txId: bigint,
): Promise<Hash> {
  return wallet.contract.write.approvePending([txId], {
    account: requireWalletAccount(wallet.walletClient),
    chain: wallet.chain,
  });
}

/**
 * Cancel a pending transaction. Only callable by the NFT owner.
 */
export async function cancelTransaction(
  wallet: Wallet,
  txId: bigint,
): Promise<Hash> {
  return wallet.contract.write.cancelPending([txId], {
    account: requireWalletAccount(wallet.walletClient),
    chain: wallet.chain,
  });
}

/**
 * Add or remove an operator (agent hot wallet).
 */
export async function setOperator(
  wallet: Wallet,
  operator: Address,
  authorized: boolean,
): Promise<Hash> {
  return wallet.contract.write.setOperator([operator, authorized], {
    account: requireWalletAccount(wallet.walletClient),
    chain: wallet.chain,
  });
}

// ─── Factory: Deploy New Wallets ───

/**
 * Deploy a new AgentAccountV2 wallet via the factory (CREATE2).
 * Returns the deterministic wallet address.
 */
export async function deployWallet(config: {
  factoryAddress: Address;
  tokenContract: Address;
  tokenId: bigint;
  chain: keyof typeof CHAINS;
  rpcUrl?: string;
  walletClient: WalletClient;
}): Promise<{ walletAddress: Address; txHash: Hash }> {
  const chain = CHAINS[config.chain];
  if (!chain) throw new Error(`Unsupported chain: ${config.chain}`);

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const factory = getContract({
    address: config.factoryAddress,
    abi: AgentAccountFactoryV2Abi,
    client: { public: publicClient, wallet: config.walletClient },
  });

  // Get deterministic address first
  const walletAddress = (await factory.read.getAddress([
    config.tokenContract,
    config.tokenId,
  ])) as Address;

  // Deploy
  const txHash = await factory.write.createAccount(
    [config.tokenContract, config.tokenId],
    { account: requireWalletAccount(config.walletClient), chain },
  );

  return { walletAddress, txHash };
}

/**
 * Compute the deterministic wallet address without deploying.
 */
export async function getWalletAddress(config: {
  factoryAddress: Address;
  tokenContract: Address;
  tokenId: bigint;
  chain: string;
  rpcUrl?: string;
}): Promise<Address> {
  const chain = CHAINS[config.chain];
  if (!chain) throw new Error(`Unsupported chain: ${config.chain}`);

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const factory = getContract({
    address: config.factoryAddress,
    abi: AgentAccountFactoryV2Abi,
    client: publicClient,
  });

  return factory.read.getAddress([
    config.tokenContract,
    config.tokenId,
  ]) as Promise<Address>;
}

// ─── [MAX-ADDED] Value-Add Features for Agent Customers ───

/**
 * [MAX-ADDED] Budget forecast with period-aware remaining capacity.
 * Why: Agents need to know not just "how much is left" but "when does budget reset"
 * so they can plan spending across time windows and avoid unnecessary queuing.
 */
export async function getBudgetForecast(
  wallet: Wallet,
  token: Address = NATIVE_TOKEN,
  now?: number,
): Promise<BudgetForecast> {
  const [perTxLimit, remainingInPeriod] =
    await wallet.contract.read.remainingBudget([token]);
  const [_policyPerTx, periodLimit, periodLength, periodSpent, periodStart] =
    await wallet.contract.read.spendPolicies([token]);

  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const periodEnd = Number(periodStart) + Number(periodLength);
  const secondsUntilReset = Math.max(0, periodEnd - currentTime);
  const utilizationPercent =
    periodLimit > 0n ? Number((periodSpent * 100n) / periodLimit) : 0;

  return {
    token,
    perTxLimit,
    remainingInPeriod,
    periodLimit,
    periodLength: Number(periodLength),
    periodSpent,
    periodStart: Number(periodStart),
    secondsUntilReset,
    utilizationPercent,
  };
}

/**
 * [MAX-ADDED] Wallet health check — diagnostic snapshot for agent self-monitoring.
 * Why: Agents need a single-call way to verify their wallet is properly configured,
 * check operator status, and monitor queue depth before executing transactions.
 */
export async function getWalletHealth(
  wallet: Wallet,
  operatorsToCheck: Address[] = [],
  tokensToCheck: Address[] = [NATIVE_TOKEN],
  now?: number,
): Promise<WalletHealth> {
  // Read wallet identity
  const [tokenContract, tokenId, operatorEpoch] = await Promise.all([
    wallet.contract.read.tokenContract(),
    wallet.contract.read.tokenId(),
    wallet.contract.read.operatorEpoch(),
  ]);

  // Check operator status
  const activeOperators = await Promise.all(
    operatorsToCheck.map(async (addr) => ({
      address: addr,
      active: (await wallet.contract.read.isOperatorActive([addr])) as boolean,
    })),
  );

  // Count pending queue depth
  const pendingNonce = (await wallet.contract.read.pendingNonce()) as bigint;
  let pendingQueueDepth = 0;
  for (let i = 0n; i < pendingNonce; i++) {
    const [, , , , createdAt, executed, cancelled] =
      await wallet.contract.read.getPending([i]);
    if (!executed && !cancelled && createdAt > 0n) pendingQueueDepth++;
  }

  // Budget forecasts for requested tokens
  const budgets = await Promise.all(
    tokensToCheck.map((t) => getBudgetForecast(wallet, t, now)),
  );

  return {
    address: wallet.address,
    tokenContract: tokenContract as Address,
    tokenId: tokenId as bigint,
    operatorEpoch: operatorEpoch as bigint,
    activeOperators,
    pendingQueueDepth,
    budgets,
  };
}

/**
 * [MAX-ADDED] Batch agent token transfers — multiple transfers in sequential calls.
 * Why: Agents often need to pay multiple recipients (tips, fees, splits). This helper
 * reduces boilerplate and returns all tx hashes. Each is a separate on-chain tx
 * (true batching would need a multicall contract, but this is the safe SDK-level helper).
 */
export async function batchAgentTransfer(
  wallet: Wallet,
  transfers: BatchTransfer[],
): Promise<Hash[]> {
  const hashes: Hash[] = [];
  for (const t of transfers) {
    const hash = await wallet.contract.write.agentTransferToken(
      [t.token, t.to, t.amount],
      {
        account: requireWalletAccount(wallet.walletClient),
        chain: wallet.chain,
      },
    );
    hashes.push(hash);
  }
  return hashes;
}

/**
 * [MAX-ADDED] Activity history — query past wallet events for self-auditing.
 * Why: Agents need to verify what happened on-chain (transfers, operator changes,
 * policy updates) without relying on external indexers. This queries event logs directly.
 */
export async function getActivityHistory(
  wallet: Wallet,
  options: { fromBlock?: bigint; toBlock?: bigint | "latest" } = {},
): Promise<ActivityEntry[]> {
  const fromBlock = options.fromBlock ?? 0n;
  const toBlock = options.toBlock ?? ("latest" as const);

  const eventConfigs = [
    { eventName: "TransactionExecuted" as const, type: "execution" as const },
    { eventName: "TransactionQueued" as const, type: "queued" as const },
    { eventName: "TransactionApproved" as const, type: "approved" as const },
    { eventName: "TransactionCancelled" as const, type: "cancelled" as const },
    {
      eventName: "SpendPolicyUpdated" as const,
      type: "policy_update" as const,
    },
    { eventName: "OperatorUpdated" as const, type: "operator_update" as const },
  ];

  const allEntries: ActivityEntry[] = [];

  for (const { eventName, type } of eventConfigs) {
    const logs = await wallet.publicClient.getContractEvents({
      address: wallet.address,
      abi: AgentAccountV2Abi,
      eventName,
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
      const rawArgs =
        log && typeof log === "object" && "args" in log
          ? (log as { args?: Record<string, JsonValue> }).args
          : undefined;
      allEntries.push({
        type,
        blockNumber: log.blockNumber ?? 0n,
        transactionHash: log.transactionHash ?? ("0x" as Hash),
        args: rawArgs ?? {},
      });
    }
  }

  // Sort by block number ascending
  allEntries.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  return allEntries;
}

// ─── Event Listeners ───

/**
 * Watch for TransactionQueued events (over-limit transactions needing approval).
 * Returns an unwatch function.
 */
export function onTransactionQueued(
  wallet: Wallet,
  callback: (event: QueuedEvent) => void,
): () => void {
  return wallet.publicClient.watchContractEvent({
    address: wallet.address,
    abi: AgentAccountV2Abi,
    eventName: "TransactionQueued",
    onLogs: (logs) => {
      for (const log of logs) {
        const args =
          log && typeof log === "object" && "args" in log
            ? (
                log as {
                  args?: {
                    txId?: bigint;
                    to?: Address;
                    value?: bigint;
                    token?: Address;
                    amount?: bigint;
                  };
                }
              ).args
            : undefined;
        if (
          !args ||
          args.txId === undefined ||
          args.to === undefined ||
          args.value === undefined ||
          args.token === undefined ||
          args.amount === undefined ||
          !log.transactionHash
        ) {
          continue;
        }
        callback({
          txId: args.txId,
          to: args.to,
          value: args.value,
          token: args.token,
          amount: args.amount,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        });
      }
    },
  });
}

/**
 * Watch for TransactionExecuted events.
 */
export function onTransactionExecuted(
  wallet: Wallet,
  callback: (event: {
    target: Address;
    value: bigint;
    executor: Address;
    transactionHash: Hash;
  }) => void,
): () => void {
  return wallet.publicClient.watchContractEvent({
    address: wallet.address,
    abi: AgentAccountV2Abi,
    eventName: "TransactionExecuted",
    onLogs: (logs) => {
      for (const log of logs) {
        const args =
          log && typeof log === "object" && "args" in log
            ? (
                log as {
                  args?: {
                    target?: Address;
                    value?: bigint;
                    executor?: Address;
                  };
                }
              ).args
            : undefined;
        const transactionHash = log.transactionHash;
        if (
          !args ||
          args.target === undefined ||
          args.value === undefined ||
          args.executor === undefined ||
          !transactionHash
        ) {
          continue;
        }
        callback({
          target: args.target,
          value: args.value,
          executor: args.executor,
          transactionHash,
        });
      }
    },
  });
}

export type {
  BridgeChain,
  BridgeOptions,
  BridgeResult,
  BurnResult,
} from "./bridge/index.js";
// ─── CCTP V2 Cross-Chain Bridge ─────────────────────────────────────────────
export {
  BRIDGE_CHAIN_IDS,
  BridgeError,
  BridgeModule,
  CCTP_DOMAIN_IDS,
  createBridge,
  ERC20BridgeAbi,
  FINALITY_THRESHOLD,
  MESSAGE_TRANSMITTER_V2,
  MessageTransmitterV2Abi,
  TOKEN_MESSENGER_V2,
  TokenMessengerV2Abi,
  USDC_CONTRACT,
} from "./bridge/index.js";
export type {
  AgentIdentity,
  AgentModelMetadata,
  AgentRegistrationFile,
  AgentRegistrationRef,
  AgentServiceEndpoint,
  ERC8004ClientConfig,
  MetadataEntry,
  RegistrationResult,
  SupportedChain,
  SupportedTrustMechanism,
} from "./identity/erc8004.js";
// ─── ERC-8004: Trustless Agents — Identity Registry ─────────────────────────
export {
  buildDataURI,
  ERC8004Client,
  ERC8004IdentityRegistryAbi,
  formatAgentRegistry,
  KNOWN_REGISTRY_ADDRESSES,
  METADATA_KEYS,
  parseDataURI,
  REGISTRATION_FILE_TYPE,
  resolveAgentURI,
  validateRegistrationFile,
} from "./identity/erc8004.js";
export type {
  AgentReputationSummary,
  FeedbackEntry,
  FeedbackFilters,
  GiveFeedbackParams,
  ReputationClientConfig,
  RespondToFeedbackParams,
} from "./identity/reputation.js";
// ─── ERC-8004: Reputation Registry ─────────────────────────────────────────
export {
  ReputationClient,
  ReputationRegistryAbi,
} from "./identity/reputation.js";
export type {
  ParsedUAID,
  RegisterUAIDParams,
  UAIDProtocol,
  UAIDResolution,
  UAIDResolverConfig,
  UniversalAgentIdentity,
} from "./identity/uaid.js";
// ─── UAID: Cross-Chain Identity Resolution (HOL Registry Broker) ────────────
export { UAIDResolver } from "./identity/uaid.js";
export type {
  RequestValidationParams,
  RespondToValidationParams,
  ValidationClientConfig,
  ValidationStatus,
  ValidationSummary,
} from "./identity/validation.js";
// ─── ERC-8004: Validation Registry ─────────────────────────────────────────
export {
  ValidationClient,
  ValidationRegistryAbi,
} from "./identity/validation.js";
export type {
  SwapModuleConfig,
  SwapOptions,
  SwapQuote,
  SwapResult,
  UniswapFeeTier,
} from "./swap/index.js";
// ─── SwapModule — Uniswap V3 token swap aggregator ──────────────────────────
export {
  applySlippage,
  attachSwap,
  BASE_TOKENS,
  calcDeadline,
  calcProtocolFee,
  DEFAULT_SLIPPAGE_BPS,
  ERC20Abi,
  PROTOCOL_FEE_BPS,
  PROTOCOL_FEE_COLLECTOR,
  SwapModule,
  UniswapV3QuoterV2Abi,
  UniswapV3RouterAbi,
} from "./swap/index.js";

// x402 already exported above from original index.ts

// ─── Convenience: env-variable-driven wallet bootstrap ──────────────────────
export {
  setPolicyFromEnv,
  walletFromEnv,
  x402FromEnv,
} from "./convenience.js";
// ─── Mutual Stake Escrow ─────────────────────────────────────────────────────
export { MutualStakeEscrow } from "./escrow/MutualStakeEscrow.js";
export type {
  CreateEscrowParams,
  EscrowCreated,
  EscrowDetails,
  TxResult as EscrowTxResult,
} from "./escrow/types.js";
export { TaskStatus } from "./escrow/types.js";
export {
  encodeHashVerifierData,
  encodeOptimisticVerifierData,
  resolveVerifierAddress,
  VERIFIER_ADDRESSES,
} from "./escrow/verifiers.js";
export type {
  AuditEntry,
  DraftEntry,
  PaymentIntent,
  PolicyResult,
  PolicyStatus,
  SpendingPolicyConfig,
} from "./policy/SpendingPolicy.js";
// ─── SpendingPolicy — Programmable spending guardrails ───────────────────────
export { SpendingPolicy } from "./policy/SpendingPolicy.js";
export type {
  UptoAuthorizationRecord,
  UptoAuthorizationRequest,
  UptoAuthorizationStatus,
  UptoBillingSnapshot,
  UptoSettlementOptions,
  UptoSettlementRecord,
  WalletLedgerDelta,
} from "./policy/UptoBillingPolicy.js";
// ─── UptoBillingPolicy — x402 usage-based settlement accounting ─────────────
export { UptoBillingPolicy } from "./policy/UptoBillingPolicy.js";

// ─── v6: Multi-Token Support ─────────────────────────────────────────────────

export type {
  PaymentContext,
  PaymentRail,
  RailConfig,
  RailStatus,
  RoutingDecision,
} from "./router/index.js";
// ─── Payment Router ───────────────────────────────────────────────────────────
export { PaymentRouter } from "./router/index.js";
export type { TokenInfo } from "./tokens/decimals.js";
// Token decimal normalization
export {
  formatBalance,
  parseAmount,
  toHuman,
  toRaw,
} from "./tokens/decimals.js";
export type { AddTokenParams, TokenEntry } from "./tokens/registry.js";
// TokenRegistry — pre-populated multi-chain token address registry
export {
  ARBITRUM_REGISTRY,
  AVALANCHE_REGISTRY,
  BASE_REGISTRY,
  BASE_SEPOLIA_REGISTRY,
  ETHEREUM_REGISTRY,
  getGlobalRegistry,
  getNativeToken,
  LINEA_REGISTRY,
  OPTIMISM_REGISTRY,
  POLYGON_REGISTRY,
  SONIC_REGISTRY,
  TokenRegistry,
  UNICHAIN_REGISTRY,
  WORLDCHAIN_REGISTRY,
} from "./tokens/registry.js";
export type {
  SolanaTokenInfo,
  SolanaTokenSymbol,
  SolanaTxResult,
  SolanaWalletConfig,
  SolBalanceResult,
  SplBalanceResult,
} from "./tokens/solana.js";
// Solana SPL token support (optional peer dependency: @solana/web3.js)
export {
  createSolanaWallet,
  SOLANA_TOKEN_DECIMALS,
  SOLANA_TOKENS,
  SolanaWallet,
} from "./tokens/solana.js";
export type {
  NativeBalanceResult,
  TokenBalanceResult,
  TransferContext,
  TransferOptions,
} from "./tokens/transfers.js";
// Multi-token EVM transfers (direct EOA/hot-wallet operations)
export {
  encodeERC20Transfer,
  getBalances,
  getNativeBalance,
  getTokenBalance,
  sendNative,
  sendToken,
} from "./tokens/transfers.js";
// x402 multi-asset resolution (v6 additions)
export {
  buildSupportedAssets,
  isStablecoin,
  parseNetworkChainId,
  resolveAssetAddress,
  resolveAssetDecimals,
} from "./x402/multi-asset.js";
