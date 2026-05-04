import {
  createPublicClient,
  http,
  getContract,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
  type Chain,
  zeroAddress,
} from "viem";
import { base, baseSepolia, mainnet, arbitrum, polygon } from "viem/chains";
import { AgentAccountV2Abi, AgentAccountFactoryV2Abi } from "./abi.js";
import type {
  AgentWalletConfig,
  SpendPolicy,
  BudgetStatus,
  PendingTx,
  ExecuteResult,
  QueuedEvent,
  BudgetForecast,
  WalletHealth,
  ActivityEntry,
  BatchTransfer,
} from "./types.js";

export type {
  SpendPolicy,
  BudgetStatus,
  PendingTx,
  ExecuteResult,
  AgentWalletConfig,
  QueuedEvent,
  BudgetForecast,
  WalletHealth,
  ActivityEntry,
  BatchTransfer,
} from "./types.js";
export { AgentAccountV2Abi, AgentAccountFactoryV2Abi } from "./abi.js";

// [MAX-ADDED] x402 protocol support
export {
  X402Client,
  X402BudgetTracker,
  X402PaymentError,
  X402BudgetExceededError,
  createX402Client,
  createX402Fetch,
  wrapWithX402,
  USDC_ADDRESSES,
  DEFAULT_SUPPORTED_NETWORKS,
} from "./x402/index.js";
export type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402SettlementResponse,
  X402ResourceInfo,
  X402ServiceBudget,
  X402TransactionLog,
  X402ClientConfig,
} from "./x402/index.js";

const CHAINS: Record<string, Chain> = {
  base,
  "base-sepolia": baseSepolia,
  ethereum: mainnet,
  arbitrum,
  polygon,
};

/** Native ETH token address (zero address) */
export const NATIVE_TOKEN: Address = zeroAddress;

// ─── Core SDK Functions ───

/**
 * Create a wallet client connected to an existing AgentAccountV2.
 */
export function createWallet(
  config: AgentWalletConfig & { walletClient: WalletClient },
) {
  const chain = CHAINS[config.chain];
  if (!chain) throw new Error(`Unsupported chain: ${config.chain}`);

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const contract = getContract({
    address: config.accountAddress,
    abi: AgentAccountV2Abi,
    client: { public: publicClient, wallet: config.walletClient },
  });

  return {
    address: config.accountAddress,
    contract,
    publicClient,
    walletClient: config.walletClient,
    chain,
  };
}

type Wallet = ReturnType<typeof createWallet>;

/**
 * Set a spend policy for a token. Only callable by the NFT owner.
 * Use NATIVE_TOKEN (address(0)) for native ETH.
 */
export async function setSpendPolicy(
  wallet: Wallet,
  policy: SpendPolicy,
): Promise<Hash> {
  const periodLength = policy.periodLength || 86400;

  const hash = await wallet.contract.write.setSpendPolicy(
    [policy.token, policy.perTxLimit, policy.periodLimit, BigInt(periodLength)],
    { account: wallet.walletClient.account!, chain: wallet.chain },
  );

  return hash;
}

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
    { value, account: wallet.walletClient.account!, chain: wallet.chain },
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
 * Check remaining autonomous budget for a token.
 */
export async function checkBudget(
  wallet: Wallet,
  token: Address = NATIVE_TOKEN,
): Promise<BudgetStatus> {
  const [perTxLimit, remainingInPeriod] =
    await wallet.contract.read.remainingBudget([token]);

  return {
    token,
    perTxLimit,
    remainingInPeriod,
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
    account: wallet.walletClient.account!,
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
    account: wallet.walletClient.account!,
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
    account: wallet.walletClient.account!,
    chain: wallet.chain,
  });
}

/**
 * Transfer ERC20 tokens as the agent, respecting spend limits.
 */
export async function agentTransferToken(
  wallet: Wallet,
  params: { token: Address; to: Address; amount: bigint },
): Promise<Hash> {
  return wallet.contract.write.agentTransferToken(
    [params.token, params.to, params.amount],
    { account: wallet.walletClient.account!, chain: wallet.chain },
  );
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
    { account: config.walletClient.account!, chain },
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
      (await wallet.contract.read.getPending([i])) as [
        any,
        any,
        any,
        any,
        bigint,
        boolean,
        boolean,
      ];
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
      { account: wallet.walletClient.account!, chain: wallet.chain },
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
  options: { fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<ActivityEntry[]> {
  const fromBlock = options.fromBlock ?? 0n;
  const toBlock = options.toBlock ?? ("latest" as any);

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
      allEntries.push({
        type,
        blockNumber: log.blockNumber ?? 0n,
        transactionHash: log.transactionHash ?? ("0x" as Hash),
        args: (log as any).args ?? {},
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
        const args = (log as any).args;
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
        const args = (log as any).args;
        callback({
          target: args.target,
          value: args.value,
          executor: args.executor,
          transactionHash: log.transactionHash!,
        });
      }
    },
  });
}

// ─── ERC-8004: Trustless Agents — Identity Registry ─────────────────────────
export {
  ERC8004Client,
  ERC8004IdentityRegistryAbi,
  METADATA_KEYS,
  REGISTRATION_FILE_TYPE,
  KNOWN_REGISTRY_ADDRESSES,
  buildDataURI,
  parseDataURI,
  resolveAgentURI,
  validateRegistrationFile,
  formatAgentRegistry,
} from "./identity/erc8004.js";
export type {
  AgentServiceEndpoint,
  SupportedTrustMechanism,
  AgentRegistrationRef,
  AgentRegistrationFile,
  AgentModelMetadata,
  AgentIdentity,
  MetadataEntry,
  ERC8004ClientConfig,
  RegistrationResult,
  SupportedChain,
} from "./identity/erc8004.js";

// ─── ERC-8004: Reputation Registry ─────────────────────────────────────────
export {
  ReputationClient,
  ReputationRegistryAbi,
} from "./identity/reputation.js";
export type {
  ReputationClientConfig,
  GiveFeedbackParams,
  FeedbackEntry,
  AgentReputationSummary,
  FeedbackFilters,
  RespondToFeedbackParams,
} from "./identity/reputation.js";

// ─── ERC-8004: Validation Registry ─────────────────────────────────────────
export {
  ValidationClient,
  ValidationRegistryAbi,
} from "./identity/validation.js";
export type {
  ValidationClientConfig,
  RequestValidationParams,
  RespondToValidationParams,
  ValidationStatus,
  ValidationSummary,
} from "./identity/validation.js";

// ─── UAID: Cross-Chain Identity Resolution (HOL Registry Broker) ────────────
export { UAIDResolver } from "./identity/uaid.js";
export type {
  UAIDProtocol,
  ParsedUAID,
  UAIDResolution,
  UniversalAgentIdentity,
  UAIDResolverConfig,
  RegisterUAIDParams,
} from "./identity/uaid.js";

// ─── SwapModule — Uniswap V3 token swap aggregator ──────────────────────────
export {
  SwapModule,
  attachSwap,
  calcProtocolFee,
  applySlippage,
  calcDeadline,
} from "./swap/index.js";
export {
  UniswapV3RouterAbi,
  UniswapV3QuoterV2Abi,
  ERC20Abi,
} from "./swap/index.js";
export {
  BASE_TOKENS,
  UNISWAP_V3_BASE,
  PROTOCOL_FEE_BPS,
  PROTOCOL_FEE_COLLECTOR,
  DEFAULT_SLIPPAGE_BPS,
} from "./swap/index.js";
export type {
  UniswapFeeTier,
  SwapQuote,
  SwapOptions,
  SwapResult,
  SwapModuleConfig,
} from "./swap/index.js";

// ─── CCTP V2 Cross-Chain Bridge ─────────────────────────────────────────────
export {
  BridgeModule,
  BridgeError,
  createBridge,
  CCTP_DOMAIN_IDS,
  BRIDGE_CHAIN_IDS,
  USDC_CONTRACT,
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2,
  FINALITY_THRESHOLD,
} from "./bridge/index.js";
export {
  TokenMessengerV2Abi,
  MessageTransmitterV2Abi,
  ERC20BridgeAbi,
} from "./bridge/index.js";
export type {
  BridgeChain,
  BridgeOptions,
  BurnResult,
  BridgeResult,
} from "./bridge/index.js";

// x402 already exported above from original index.ts

// ─── SpendingPolicy — Programmable spending guardrails ───────────────────────
export { SpendingPolicy } from "./policy/SpendingPolicy.js";
export type {
  SpendingPolicyConfig,
  PaymentIntent,
  PolicyResult,
  PolicyStatus,
  AuditEntry,
  DraftEntry,
} from "./policy/SpendingPolicy.js";

// ─── UptoBillingPolicy — x402 usage-based settlement accounting ─────────────
export { UptoBillingPolicy } from "./policy/UptoBillingPolicy.js";
export type {
  UptoAuthorizationStatus,
  UptoAuthorizationRequest,
  UptoSettlementOptions,
  UptoSettlementRecord,
  UptoAuthorizationRecord,
  WalletLedgerDelta,
  UptoBillingSnapshot,
} from "./policy/UptoBillingPolicy.js";

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
  resolveVerifierAddress,
  encodeHashVerifierData,
  encodeOptimisticVerifierData,
  VERIFIER_ADDRESSES,
} from "./escrow/verifiers.js";

// ─── Convenience: env-variable-driven wallet bootstrap ──────────────────────
export {
  walletFromEnv,
  setPolicyFromEnv,
  x402FromEnv,
} from "./convenience.js";
// ─── v6: Multi-Token Support ─────────────────────────────────────────────────

// TokenRegistry — pre-populated multi-chain token address registry
export {
  TokenRegistry,
  getGlobalRegistry,
  getNativeToken,
  ETHEREUM_REGISTRY,
  BASE_REGISTRY,
  ARBITRUM_REGISTRY,
  OPTIMISM_REGISTRY,
  POLYGON_REGISTRY,
  AVALANCHE_REGISTRY,
  UNICHAIN_REGISTRY,
  LINEA_REGISTRY,
  SONIC_REGISTRY,
  WORLDCHAIN_REGISTRY,
  BASE_SEPOLIA_REGISTRY,
} from "./tokens/registry.js";
export type { TokenEntry, AddTokenParams } from "./tokens/registry.js";

// Token decimal normalization
export {
  toRaw,
  toHuman,
  formatBalance,
  parseAmount,
} from "./tokens/decimals.js";
export type { TokenInfo } from "./tokens/decimals.js";

// Multi-token EVM transfers (direct EOA/hot-wallet operations)
export {
  sendToken,
  sendNative,
  getTokenBalance,
  getNativeBalance,
  getBalances,
  encodeERC20Transfer,
} from "./tokens/transfers.js";
export type {
  TransferContext,
  TransferOptions,
  TokenBalanceResult,
  NativeBalanceResult,
} from "./tokens/transfers.js";

// Solana SPL token support (optional peer dependency: @solana/web3.js)
export {
  SolanaWallet,
  createSolanaWallet,
  SOLANA_TOKENS,
  SOLANA_TOKEN_DECIMALS,
} from "./tokens/solana.js";
export type {
  SolanaWalletConfig,
  SolanaTokenInfo,
  SolanaTokenSymbol,
  SolBalanceResult,
  SplBalanceResult,
  SolanaTxResult,
} from "./tokens/solana.js";

// x402 multi-asset resolution (v6 additions)
export {
  resolveAssetAddress,
  resolveAssetDecimals,
  buildSupportedAssets,
  isStablecoin,
  parseNetworkChainId,
} from "./x402/multi-asset.js";

// ─── Payment Router ───────────────────────────────────────────────────────────
export { PaymentRouter } from "./router/index.js";
export type {
  PaymentRail,
  RailStatus,
  RailConfig,
  PaymentContext,
  RoutingDecision,
} from "./router/index.js";
