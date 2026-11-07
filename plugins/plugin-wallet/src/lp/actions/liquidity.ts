/**
 * Defines `liquidityAction`, the LP management action promoted into
 * subactions (list pools, open/close/reposition a position, list positions)
 * dispatched against `LpManagementService`'s registered DEX providers. Formats
 * pool and position results into human-readable summaries and resolves
 * finance/crypto/wallet-context gating the same way the top-level wallet
 * action does. The open/close/reposition writes move real funds, so they
 * pass through the same two gates as wallet router writes: the GHSA-gh63
 * injection guard (`assertWalletFinancialActionAllowed`) and the
 * GHSA-rqm7 confirmation gate (`gateWalletFinancialExecution`), both keyed
 * off the single-sourced ON_CHAIN_WRITE_SUBACTIONS set.
 */
import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { privateKeyToAccount } from "viem/accounts";
import { assertWalletFinancialActionAllowed } from "../../security/wallet-context-safety.ts";
import {
  gateWalletFinancialExecution,
  type WalletFinancialWriteParams,
  walletFinancialGateActionResult,
} from "../../security/wallet-financial-confirmation.ts";
import {
  getLpManagementService,
  type LpManagementService,
  NoMatchingLpProtocolError,
} from "../services/LpManagementService.ts";
import type {
  IUserLpProfileService,
  IVaultService,
  LpActionParams,
  LpManagementSubaction,
  LpPositionDetails,
  PoolInfo,
  TokenBalance,
  UserLpProfile,
} from "../types.ts";
import { getChainConfig } from "../types.ts";

const SOLANA_DEXES = new Set(["raydium", "orca", "meteora"]);
const EVM_DEXES = new Set(["uniswap", "aerodrome", "pancakeswap"]);

type PoolTokenWithAddress = PoolInfo["tokenA"] & { address?: string };
type TransactionWithHash = { transactionId?: string; hash?: string };

function tokenLabel(token: PoolInfo["tokenA"]): string | undefined {
  const withAddress = token as PoolTokenWithAddress;
  return token.symbol || token.mint || withAddress.address;
}

function transactionLabel(result: TransactionWithHash): string {
  return result.transactionId || result.hash || "submitted";
}

function isLpPosition(
  position: LpPositionDetails | null,
): position is LpPositionDetails {
  return position !== null;
}

function selectedContextMatches(
  state: State | undefined,
  contexts: readonly string[],
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

const formatPositions = (positions: LpPositionDetails[]): string => {
  if (!positions || positions.length === 0) {
    return "No active LP positions found.";
  }

  let response = "LP positions:\n";
  positions.forEach((pos, index) => {
    const underlying = (pos.underlyingTokens || [])
      .map(
        (token: TokenBalance) =>
          `${token.uiAmount?.toFixed(4) || token.balance || "N/A"} ${token.symbol || token.address}`,
      )
      .join(" / ");
    response +=
      `\n${index + 1}. ${pos.poolId} on ${pos.dex}\n` +
      `   Value: $${pos.valueUsd?.toFixed(2) || "N/A"}\n` +
      `   Tokens: ${underlying || "N/A"}\n` +
      `   LP balance: ${pos.lpTokenBalance.uiAmount?.toFixed(6) || pos.lpTokenBalance.balance || "N/A"} ${pos.lpTokenBalance.symbol || ""}\n`;
  });
  return response;
};

const formatPools = (pools: PoolInfo[]): string => {
  if (!pools || pools.length === 0) {
    return "No matching LP pools are registered or available.";
  }

  let response = "LP pools:\n";
  pools.forEach((pool, index) => {
    // Pool yields are fractions (0.125 = 12.5%), as in YieldOptimizationService.
    const rate = pool.apr ?? pool.apy;
    const tokenA = tokenLabel(pool.tokenA) || "tokenA";
    const tokenB = tokenLabel(pool.tokenB) || "tokenB";
    response +=
      `\n${index + 1}. ${pool.displayName || pool.id} on ${pool.dex}\n` +
      `   Pair: ${tokenA}/${tokenB}\n` +
      `   APR: ${typeof rate === "number" ? `${(rate * 100).toFixed(2)}%` : "N/A"}\n` +
      `   TVL: ${pool.tvl !== undefined ? `$${pool.tvl.toLocaleString()}` : "N/A"}\n`;
  });

  return response;
};

const parseIntentFromMessage = (text: string): LpActionParams | null => {
  const lowerText = text.toLowerCase();

  if (
    lowerText.includes("start lp management") ||
    lowerText.includes("set me up") ||
    lowerText.includes("onboard") ||
    lowerText.includes("get started")
  ) {
    return { subaction: "onboard" };
  }

  if (
    lowerText.includes("auto-rebalance") ||
    lowerText.includes("auto rebalance") ||
    lowerText.includes("preference") ||
    lowerText.includes("slippage")
  ) {
    return { subaction: "set_preferences" };
  }

  if (
    lowerText.includes("rebalance") ||
    lowerText.includes("reposition") ||
    lowerText.includes("adjust range") ||
    lowerText.includes("move range")
  ) {
    return { subaction: "reposition" };
  }

  if (
    lowerText.includes("withdraw") ||
    lowerText.includes("remove liquidity") ||
    lowerText.includes("close position") ||
    (lowerText.includes("exit") && lowerText.includes("position"))
  ) {
    return { subaction: "close" };
  }

  if (
    lowerText.includes("add liquidity") ||
    lowerText.includes("deposit") ||
    lowerText.includes("open position") ||
    (lowerText.includes("add") && lowerText.includes("pool"))
  ) {
    return { subaction: "open" };
  }

  if (
    lowerText.includes("show pools") ||
    lowerText.includes("list pools") ||
    lowerText.includes("find pools") ||
    lowerText.includes("best pool")
  ) {
    return { subaction: "list_pools" };
  }

  if (
    (lowerText.includes("show") &&
      (lowerText.includes("position") || lowerText.includes("lp"))) ||
    lowerText.includes("my lp") ||
    (lowerText.includes("check") && lowerText.includes("position"))
  ) {
    return { subaction: "list_positions" };
  }

  return null;
};

function subactionFromLegacyIntent(
  intent?: LpActionParams["intent"],
): LpManagementSubaction | undefined {
  switch (intent) {
    case "onboard_lp":
      return "onboard";
    case "deposit_lp":
    case "create_concentrated_lp":
      return "open";
    case "withdraw_lp":
      return "close";
    case "show_lps":
    case "show_concentrated_lps":
      return "list_positions";
    case "rebalance_concentrated_lp":
      return "reposition";
    case "set_lp_preferences":
      return "set_preferences";
    default:
      return undefined;
  }
}

function normalizeParams(
  message: Memory,
  handlerParams?: Record<string, unknown>,
): LpActionParams | null {
  const contentParams = (message.content || {}) as Record<string, unknown>;
  const params = {
    ...contentParams,
    ...(handlerParams || {}),
  } as LpActionParams & {
    action?: LpManagementSubaction;
    op?: LpManagementSubaction;
  };

  // Canonical planner discriminator is action; keep legacy aliases accepted.
  if (!params.subaction && params.action) {
    params.subaction = params.action;
  }
  if (!params.subaction && params.op) {
    params.subaction = params.op;
  }
  if (!params.subaction && params.intent) {
    params.subaction = subactionFromLegacyIntent(params.intent);
  }
  if (!params.subaction && typeof contentParams.text === "string") {
    const parsed = parseIntentFromMessage(contentParams.text);
    if (parsed) {
      Object.assign(params, parsed);
    }
  }

  return params.subaction ? params : null;
}

function resolveChain(params: LpActionParams): {
  chain?: "solana" | "evm";
  chainId?: number;
} {
  const dex = (params.dex || params.dexName || "").toLowerCase();
  let chain = params.chain?.toString().toLowerCase();
  let chainId = params.chainId;

  const numericChain = chain && /^\d+$/.test(chain) ? Number(chain) : undefined;
  const evmChain =
    numericChain !== undefined
      ? getChainConfig(numericChain)
      : chain
        ? getChainConfig(chain)
        : undefined;
  if (evmChain) {
    chain = "evm";
    chainId = evmChain.chainId;
  }

  if (!chain && SOLANA_DEXES.has(dex)) chain = "solana";
  if (!chain && EVM_DEXES.has(dex)) chain = "evm";

  if (chain !== "solana" && chain !== "evm") {
    return { chain: undefined, chainId };
  }

  return { chain, chainId };
}

function getPoolParam(params: LpActionParams): string | undefined {
  return params.pool || params.poolId;
}

function getPositionParam(params: LpActionParams): string | undefined {
  return params.position || params.positionId;
}

function getAmountParam(params: LpActionParams): LpActionParams["amount"] {
  if (params.amount !== undefined) return params.amount;
  if (
    params.tokenAAmount !== undefined ||
    params.tokenBAmount !== undefined ||
    params.lpTokenAmount !== undefined ||
    params.percentage !== undefined
  ) {
    return {
      tokenA: params.tokenAAmount,
      tokenB: params.tokenBAmount,
      lpToken: params.lpTokenAmount,
      percentage: params.percentage,
    };
  }
  return undefined;
}

function getRangeParam(params: LpActionParams): LpActionParams["range"] {
  return (
    params.range || {
      tickLowerIndex: params.tickLowerIndex,
      tickUpperIndex: params.tickUpperIndex,
      priceLower: params.priceLower,
      priceUpper: params.priceUpper,
    }
  );
}

function hasRangeValue(range: LpActionParams["range"]): boolean {
  return (
    range !== undefined &&
    (range.tickLowerIndex !== undefined ||
      range.tickUpperIndex !== undefined ||
      range.tickLower !== undefined ||
      range.tickUpper !== undefined ||
      range.priceLower !== undefined ||
      range.priceUpper !== undefined)
  );
}

function amountLabel(amount: LpActionParams["amount"]): string | undefined {
  if (amount === undefined) return undefined;
  if (typeof amount === "string") return amount;
  if (typeof amount === "number") return String(amount);
  const parts: string[] = [];
  if (amount.value !== undefined) parts.push(String(amount.value));
  if (amount.tokenA !== undefined) parts.push(`tokenA=${amount.tokenA}`);
  if (amount.tokenB !== undefined) parts.push(`tokenB=${amount.tokenB}`);
  if (amount.lpToken !== undefined) parts.push(`lpToken=${amount.lpToken}`);
  if (amount.percentage !== undefined) parts.push(`${amount.percentage}%`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// Maps LP params onto the shared confirmation-gate shape. Reads never reach
// the prompt: `requiresWalletFinancialConfirmation` fires only for the
// single-sourced write subactions (open/close/reposition here).
function lpGateParams(params: LpActionParams): WalletFinancialWriteParams {
  const range = getRangeParam(params);
  const { chain, chainId } = resolveChain(params);
  return {
    subaction: params.subaction as string,
    chain,
    chainId,
    amount: amountLabel(getAmountParam(params)),
    pool: getPoolParam(params),
    position: getPositionParam(params),
    dex: params.dex || params.dexName,
    tokenA: params.tokenA,
    tokenB: params.tokenB,
    feeTier: params.feeTier,
    range: hasRangeValue(range) ? range : undefined,
    slippageBps: params.slippageBps ?? params.maxSlippageBps,
    mode: "execute",
    dryRun: false,
  };
}

function requireEvmPrivateKey(runtime: IAgentRuntime): string {
  const rawPrivateKey = runtime.getSetting("EVM_PRIVATE_KEY");
  if (!rawPrivateKey || typeof rawPrivateKey !== "string") {
    throw new Error("EVM_PRIVATE_KEY is required for EVM LP operations.");
  }
  return rawPrivateKey;
}

function getEvmWallet(runtime: IAgentRuntime) {
  const rawPrivateKey = requireEvmPrivateKey(runtime);
  // Accept the uppercase 0X prefix too, mirroring resolveEvmPrivateKey:
  // "0X…" used to become "0x0X…", which privateKeyToAccount rejects.
  const privateKey = /^0[xX]/.test(rawPrivateKey)
    ? `0x${rawPrivateKey.slice(2)}`
    : `0x${rawPrivateKey}`;
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return { address: account.address, privateKey: privateKey as `0x${string}` };
}

async function getProfileServices(runtime: IAgentRuntime) {
  const vault = runtime.getService<IVaultService>("VaultService");
  const profileService = runtime.getService<IUserLpProfileService>(
    "UserLpProfileService",
  );
  if (!vault || !profileService) {
    throw new Error("LP vault/profile services are unavailable.");
  }
  return { vault, profileService };
}

async function requireProfile(
  runtime: IAgentRuntime,
  userId: string,
): Promise<{
  vault: IVaultService;
  profileService: IUserLpProfileService;
  profile: UserLpProfile;
}> {
  const { vault, profileService } = await getProfileServices(runtime);
  const profile = await profileService.getProfile(userId);
  if (!profile) {
    throw new Error(
      "No LP profile found. Use action=onboard before managing Solana LP positions.",
    );
  }
  return { vault, profileService, profile };
}

async function operationAuth(
  runtime: IAgentRuntime,
  userId: string,
  params: LpActionParams,
) {
  const { chain, chainId } = resolveChain(params);
  if (chain === "evm") {
    const wallet = getEvmWallet(runtime);
    return { chain, chainId, wallet, owner: wallet.address };
  }

  const { vault, profile, profileService } = await requireProfile(
    runtime,
    userId,
  );
  const userVault = await vault.getVaultKeypair(
    userId,
    profile.encryptedSecretKey,
  );
  return {
    chain: chain || "solana",
    chainId,
    userVault,
    owner: profile.vaultPublicKey,
    profile,
    profileService,
  };
}

async function handleOnboard(runtime: IAgentRuntime, userId: string) {
  const { vault, profileService } = await getProfileServices(runtime);
  const existingProfile = await profileService.getProfile(userId);
  if (existingProfile) {
    return {
      success: true,
      text: `You're already set up. Vault address: ${existingProfile.vaultPublicKey}`,
    };
  }

  const { publicKey, secretKeyEncrypted } = await vault.createVault(userId);
  const newProfile = await profileService.ensureProfile(
    userId,
    publicKey,
    secretKeyEncrypted,
  );
  return {
    success: true,
    text: `LP vault created. Vault address: ${newProfile.vaultPublicKey}. Auto-rebalancing is ${newProfile.autoRebalanceConfig.enabled ? "on" : "off"}.`,
  };
}

async function handlePreferences(
  runtime: IAgentRuntime,
  userId: string,
  params: LpActionParams,
) {
  const { profileService, profile } = await requireProfile(runtime, userId);
  const newConfig = { ...profile.autoRebalanceConfig };
  const updates: string[] = [];

  if (params.autoRebalanceEnabled !== undefined) {
    newConfig.enabled = params.autoRebalanceEnabled;
    updates.push(`autoRebalance=${newConfig.enabled}`);
  }
  if (params.minGainThresholdPercent !== undefined) {
    newConfig.minGainThresholdPercent = params.minGainThresholdPercent;
    updates.push(`minGainThresholdPercent=${params.minGainThresholdPercent}`);
  }
  const maxSlippageBps = params.maxSlippageBps ?? params.slippageBps;
  if (maxSlippageBps !== undefined) {
    newConfig.maxSlippageBps = maxSlippageBps;
    updates.push(`maxSlippageBps=${newConfig.maxSlippageBps}`);
  }
  if (params.preferredDexes) {
    newConfig.preferredDexes = params.preferredDexes;
    updates.push(`preferredDexes=${params.preferredDexes.join(",")}`);
  }

  if (updates.length === 0) {
    return {
      success: false,
      text: "No LP preference changes were provided. Set autoRebalanceEnabled, minGainThresholdPercent, slippageBps, or preferredDexes.",
    };
  }

  await profileService.updateProfile(userId, {
    autoRebalanceConfig: newConfig,
  });

  return {
    success: true,
    text: `LP preferences updated: ${updates.join(", ")}`,
  };
}

function baseRoute(params: LpActionParams) {
  const { chain, chainId } = resolveChain(params);
  return {
    chain,
    chainId,
    dex: params.dex || params.dexName,
  };
}

const BASE_UNIT_AMOUNT = /^\d+$/;

/**
 * Request-shape rejections for open/close/reposition, run before the
 * confirmation gate so the user is never asked to confirm a write the
 * provider would refuse. Mirrors the provider checks in
 * `LpManagementService`; protocol resolution throws the same errors the
 * write itself would.
 */
function lpWriteRejection(
  lp: LpManagementService,
  params: LpActionParams,
): string | undefined {
  const subaction = params.subaction;
  if (
    subaction !== "open" &&
    subaction !== "close" &&
    subaction !== "reposition"
  ) {
    return undefined;
  }
  const route = baseRoute(params);
  // operationAuth routes every non-EVM write through the Solana vault.
  const chain = route.chain ?? "solana";
  const protocol = lp.resolveProtocol({ ...route, chain });

  const unavailable =
    subaction === "reposition"
      ? !protocol.repositionPosition
      : protocol.unsupportedWrites?.includes(subaction);
  if (unavailable) {
    return `LP ${subaction} is unavailable for ${protocol.dex} on ${protocol.chain}.`;
  }
  if (
    subaction === "open" &&
    !protocol.appliesRange &&
    hasRangeValue(getRangeParam(params))
  ) {
    return `LP open on ${protocol.dex} does not apply a tick range. Omit range.`;
  }
  if (chain === "evm" && !route.chainId) {
    return `LP ${subaction} on an EVM chain needs chainId.`;
  }
  const pool = getPoolParam(params);
  if (subaction === "open" && !pool) {
    return "LP open needs pool. Use action=list_pools to find the pool id/address.";
  }
  const amount = getAmountParam(params);
  if (
    subaction === "open" &&
    amount === undefined &&
    params.amounts === undefined
  ) {
    return "LP open needs amount, a whole number of token base units.";
  }
  if (subaction === "close" && !pool) {
    if (chain === "evm") {
      return "LP close on an EVM chain needs pool.";
    }
    if (!getPositionParam(params)) {
      return "LP close needs pool or position. Use action=list_positions to find it.";
    }
  }
  const scalarAmount = typeof amount === "string" || typeof amount === "number";
  if (scalarAmount && !BASE_UNIT_AMOUNT.test(String(amount).trim())) {
    return `LP amount must be a whole number of token base units; got ${amount}.`;
  }
  if (subaction === "close") {
    if (scalarAmount && !protocol.closeAppliesAmount) {
      return `LP close on ${protocol.dex} removes the whole position. Omit amount.`;
    }
    const position = getPositionParam(params);
    if (protocol.closeNeedsTokenId && !position) {
      return `LP close on ${protocol.dex} needs position, the position NFT token id. Use action=list_positions to find it.`;
    }
    // The EVM adapter converts position to a BigInt token id.
    if (
      chain === "evm" &&
      position &&
      !BASE_UNIT_AMOUNT.test(String(position).trim())
    ) {
      return `LP close position on an EVM chain must be the position NFT token id, a whole number; got ${position}.`;
    }
  }
  return undefined;
}

/**
 * Signer precondition for open/close/reposition, run before the confirmation
 * gate so the user is never asked to confirm a write that has no signer.
 * Throws the same errors `operationAuth` does. It only looks the signer up:
 * key derivation and vault decryption stay after the confirmation.
 */
async function requireLpWriteSigner(
  runtime: IAgentRuntime,
  userId: string,
  params: LpActionParams,
): Promise<void> {
  const subaction = params.subaction;
  if (
    subaction !== "open" &&
    subaction !== "close" &&
    subaction !== "reposition"
  ) {
    return;
  }
  if (resolveChain(params).chain === "evm") {
    requireEvmPrivateKey(runtime);
    return;
  }
  await requireProfile(runtime, userId);
}

const EVM_TOKEN_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_MINT_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Request-shape rejections for list_pools/list_positions/get_position: the
 * requests a provider answers with an empty result because it cannot run
 * them. Mirrors the provider checks in `LpManagementService`.
 */
function lpReadRejection(
  lp: LpManagementService,
  params: LpActionParams,
): string | undefined {
  const subaction = params.subaction;
  if (
    subaction !== "list_pools" &&
    subaction !== "list_positions" &&
    subaction !== "get_position"
  ) {
    return undefined;
  }
  const route = baseRoute(params);

  if (subaction === "list_pools") {
    if (route.dex) {
      const protocol = lp.resolveProtocol(route);
      if (protocol.unsupportedReads?.includes(subaction)) {
        return `LP ${subaction} is unavailable for ${protocol.dex} on ${protocol.chain}.`;
      }
    }
    const tokens = [params.tokenA, params.tokenB].filter(
      (token): token is string => Boolean(token),
    );
    for (const token of tokens) {
      const evm = EVM_TOKEN_ADDRESS.test(token);
      const solana = SOLANA_MINT_ADDRESS.test(token);
      if (
        route.chain === "evm" ? !evm : route.chain ? !solana : !evm && !solana
      ) {
        return `LP list_pools filters by token contract address (EVM) or mint address (Solana), not by symbol; got ${token}.`;
      }
    }
    // Every provider filters only on a complete pair.
    if (tokens.length === 1) {
      return "LP list_pools filters by a token pair. Pass both tokenA and tokenB, or neither.";
    }
    // The EVM adapters look a pool up from its pair; they cannot enumerate.
    if (route.chain === "evm" && tokens.length === 0) {
      return "LP list_pools on an EVM chain needs tokenA and tokenB, the token contract addresses of the pair.";
    }
    return undefined;
  }

  if (route.chain === "evm" && !route.chainId) {
    return `LP ${subaction} on an EVM chain needs chainId.`;
  }
  if (subaction === "get_position") {
    // operationAuth routes every non-EVM read through the Solana vault.
    const protocol = lp.resolveProtocol({
      ...route,
      chain: route.chain ?? "solana",
    });
    if (protocol.unsupportedReads?.includes(subaction)) {
      return `LP ${subaction} is unavailable for ${protocol.dex} on ${protocol.chain}.`;
    }
    const pool = getPoolParam(params);
    if (route.chain === "evm") {
      if (!pool) return "LP get_position on an EVM chain needs pool.";
    } else if (!pool && !getPositionParam(params)) {
      return "LP get_position needs position or pool.";
    }
  }
  return undefined;
}

async function handleLpOperation(
  runtime: IAgentRuntime,
  lp: LpManagementService,
  userId: string,
  params: LpActionParams,
) {
  const route = baseRoute(params);

  switch (params.subaction) {
    case "list_pools": {
      const pools = await lp.listPools({
        ...route,
        tokenA: params.tokenA,
        tokenB: params.tokenB,
        feeTier: params.feeTier,
      });
      return { success: true, text: formatPools(pools), data: { pools } };
    }

    case "list_positions": {
      const auth = await operationAuth(runtime, userId, params);
      let positions = await lp.listPositions({
        ...route,
        chain: route.chain || auth.chain,
        chainId: route.chainId || auth.chainId,
        owner: auth.owner,
      });
      if (
        positions.length === 0 &&
        auth.chain === "solana" &&
        auth.profileService
      ) {
        const trackedPositions =
          await auth.profileService.getTrackedPositions(userId);
        positions = (
          await Promise.all(
            trackedPositions.map((tracked) =>
              lp
                .getPosition({
                  chain: "solana",
                  dex: tracked.dex,
                  owner: auth.owner,
                  pool: tracked.poolAddress,
                  position: tracked.positionIdentifier,
                })
                .catch(() => null),
            ),
          )
        ).filter(isLpPosition);
      }
      return {
        success: true,
        text: formatPositions(positions),
        data: { positions },
      };
    }

    case "get_position": {
      const auth = await operationAuth(runtime, userId, params);
      const position = await lp.getPosition({
        ...route,
        chain: route.chain || auth.chain,
        chainId: route.chainId || auth.chainId,
        owner: auth.owner,
        pool: getPoolParam(params),
        position: getPositionParam(params),
      });
      return {
        success: true,
        text: position
          ? formatPositions([position])
          : "No matching LP position found.",
        data: { position },
      };
    }

    case "open": {
      const auth = await operationAuth(runtime, userId, params);
      const result = await lp.openPosition({
        ...route,
        chain: route.chain || auth.chain,
        chainId: route.chainId || auth.chainId,
        userVault: auth.userVault,
        wallet: auth.wallet,
        owner: auth.owner,
        pool: getPoolParam(params),
        amount: getAmountParam(params),
        amounts: params.amounts,
        range: getRangeParam(params),
        slippageBps: params.slippageBps ?? params.maxSlippageBps,
      });
      return {
        success: result.success,
        text: result.success
          ? `LP position opened on ${route.dex || "registered protocol"}. Transaction: ${transactionLabel(result)}`
          : `LP open failed: ${result.error || "unknown error"}`,
        data: result,
      };
    }

    case "close": {
      const auth = await operationAuth(runtime, userId, params);
      const result = await lp.closePosition({
        ...route,
        chain: route.chain || auth.chain,
        chainId: route.chainId || auth.chainId,
        userVault: auth.userVault,
        wallet: auth.wallet,
        owner: auth.owner,
        pool: getPoolParam(params),
        position: getPositionParam(params),
        amount: getAmountParam(params),
        amounts: params.amounts,
        slippageBps: params.slippageBps ?? params.maxSlippageBps,
      });
      return {
        success: result.success,
        text: result.success
          ? `LP position closed on ${route.dex || "registered protocol"}. Transaction: ${transactionLabel(result)}`
          : `LP close failed: ${result.error || "unknown error"}`,
        data: result,
      };
    }

    case "reposition": {
      const auth = await operationAuth(runtime, userId, params);
      const result = await lp.repositionPosition({
        ...route,
        chain: route.chain || auth.chain,
        chainId: route.chainId || auth.chainId,
        userVault: auth.userVault,
        wallet: auth.wallet,
        owner: auth.owner,
        pool: getPoolParam(params),
        position: getPositionParam(params),
        amount: getAmountParam(params),
        amounts: params.amounts,
        range: getRangeParam(params),
        slippageBps: params.slippageBps ?? params.maxSlippageBps,
      });
      return {
        success: result.success,
        text: result.success
          ? `LP position repositioned on ${route.dex || "registered protocol"}. Transaction: ${transactionLabel(result)}`
          : `LP reposition failed: ${result.error || "unknown error"}`,
        data: result,
      };
    }

    default:
      return {
        success: false,
        text: `Unsupported LP action: ${params.subaction}`,
      };
  }
}

export const liquidityAction: Action = {
  name: "LIQUIDITY",
  contexts: ["finance", "crypto", "wallet", "automation"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "automation"] },
  // ADMIN matches the WALLET umbrella: core's role gate is per-action and the
  // promoted virtuals inherit the parent's gate, so write ops cannot be gated
  // above reads without leaving the parent LIQUIDITY path open.
  roleGate: { minRole: "ADMIN" },
  description:
    "Single LP/liquidity management action. action=onboard|list_pools|open|close|list_positions|get_position|set_preferences. dex=meteora|uniswap|aerodrome|pancakeswap selects the protocol; chain=solana|evm is inferred from dex when omitted. list_positions and get_position read the Solana LP vault unless chain=evm or an EVM dex is given; every EVM call except list_pools needs chainId. open and close need a signer first: action=onboard on Solana, a configured EVM key on EVM. No DEX can move the range of an open position.",
  descriptionCompressed:
    "Manage LP positions by action, chain, dex, pool, position, amount, range, token filters.",
  parameters: [
    {
      name: "action",
      description:
        "Liquidity operation: onboard, list_pools, open, close, list_positions, get_position, set_preferences.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "onboard",
          "list_pools",
          "open",
          "close",
          "list_positions",
          "get_position",
          "set_preferences",
        ],
      },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "chain",
      description:
        "Chain for the LP operation. evm open, close, list_positions and get_position also need chainId.",
      required: false,
      schema: { type: "string", enum: ["solana", "evm"] },
    },
    {
      name: "dex",
      description: "DEX/protocol name.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "pool",
      description:
        "Pool id/address. Required for open, and for close and get_position on EVM; Solana close and get_position accept pool or position.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "position",
      description:
        "LP position id. Required for close on uniswap or pancakeswap, where it is the position NFT token id (a whole number). meteora close does not read it: it closes the wallet's first position in the pool.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "amount",
      description:
        "Liquidity amount as a whole number of token base units (lamports / wei-style), not a decimal token amount. Required for open: the tokenA amount. For close, only aerodrome accepts it (LP token amount); the other DEXes remove the whole position and refuse an amount.",
      required: false,
      schema: {
        anyOf: [{ type: "string" }, { type: "number" }],
      },
    },
    {
      name: "range",
      description:
        "Concentrated liquidity tick range for open on uniswap or pancakeswap. Other DEXes refuse a range. Price bounds are not supported.",
      required: false,
      schema: {
        type: "object",
        properties: {
          tickLowerIndex: {
            type: "number",
            description: "Lower tick index of the range.",
          },
          tickUpperIndex: {
            type: "number",
            description: "Upper tick index of the range.",
          },
        },
      },
    },
    {
      name: "tokenA",
      description:
        "First token of the list_pools pair filter: a token contract address (EVM) or mint address (Solana), not a symbol. Pass tokenA and tokenB together; EVM list_pools needs both. open does not pick a pool from tokens; pass pool.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "tokenB",
      description:
        "Second token of the list_pools pair filter, in the same address form as tokenA.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "chainId",
      description:
        "Numeric EVM chain id. Required for open, close, list_positions and get_position when chain is evm.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "slippageBps",
      description:
        "Maximum allowed slippage in basis points. With set_preferences, the saved auto-rebalance slippage limit.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "autoRebalanceEnabled",
      description: "set_preferences only: turn LP auto-rebalancing on or off.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "minGainThresholdPercent",
      description:
        "set_preferences only: minimum estimated gain, in percent, before auto-rebalancing moves a position.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "preferredDexes",
      description: "set_preferences only: DEX names auto-rebalancing may use.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ],

  similes: [
    "lp_management",
    "LP_MANAGEMENT",
    "LIQUIDITY_POOL_MANAGEMENT",
    "LP_MANAGER",
    "MANAGE_LP",
    "MANAGE_LIQUIDITY",
    "MANAGE_LP_POSITIONS",
    "manage_positions",
    "manage_raydium_positions",
    "AUTOMATE_REBALANCING",
    "AUTOMATE_POSITIONS",
    "START_MANAGING_POSITIONS",
    "AUTOMATE_RAYDIUM_REBALANCING",
    "AUTOMATE_RAYDIUM_POSITIONS",
    "START_MANAGING_RAYDIUM_POSITIONS",
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Add 1 SOL to Meteora pool 5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Opening the LP position.",
          actions: ["LIQUIDITY"],
          thought:
            "User wants to provide liquidity on a DEX; LIQUIDITY action=open with dex, the pool id, and the amount in base units (1 SOL = 1000000000) routes to the LP manager.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show my current liquidity positions.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Listing your LP positions.",
          actions: ["LIQUIDITY"],
          thought:
            "Position inventory query maps to LIQUIDITY action=list_positions and returns active LP positions across pools.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Close my liquidity position in Meteora pool 5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Closing the LP position.",
          actions: ["LIQUIDITY"],
          thought:
            "Withdraw / unwind intent maps to LIQUIDITY action=close with dex and the pool or position id.",
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    handlerParams?: unknown,
  ): Promise<boolean> => {
    // The runtime validates after schema validation and passes the planner
    // arguments under `options.parameters`; direct callers pass them flat.
    const options = handlerParams as Record<string, unknown> | undefined;
    const planned = options?.parameters;
    const args =
      planned && typeof planned === "object"
        ? (planned as Record<string, unknown>)
        : options;
    if (args?.action || args?.subaction || args?.op) return true;
    if (!message.content) return false;
    if ((message.content as LpActionParams & { action?: string }).action)
      return true;
    if ((message.content as LpActionParams).subaction) return true;
    if ((message.content as LpActionParams & { op?: string }).op) return true;
    if (
      selectedContextMatches(state, [
        "finance",
        "crypto",
        "wallet",
        "automation",
      ])
    ) {
      return true;
    }

    return false;
  },

  handler: async (runtime, message, _state, handlerParams, callback) => {
    // The runtime passes the validated planner arguments under
    // `options.parameters`; direct callers pass them flat.
    const options = handlerParams as Record<string, unknown> | undefined;
    const planned = options?.parameters;
    const params = normalizeParams(
      message,
      planned && typeof planned === "object"
        ? (planned as Record<string, unknown>)
        : options,
    );
    if (!params) {
      return {
        success: false,
        text: "Use LIQUIDITY with action=list_pools, open, close, list_positions, get_position, set_preferences, or onboard.",
      };
    }

    // GHSA-gh63-5vpj-39qp: an injection-flagged message must not drive LP
    // writes, same as wallet router writes. Fires on the resolved subaction,
    // so intent parsed from raw message text is covered too.
    try {
      assertWalletFinancialActionAllowed(message, params.subaction);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await callback?.({ text, content: { error: "INVALID_PARAMS" } });
      return {
        success: false,
        text,
        data: { error: "INVALID_PARAMS" },
      };
    }

    const userId = message.entityId || "unknown-user";

    try {
      if (params.subaction === "onboard") {
        return await handleOnboard(runtime, userId);
      }
      if (params.subaction === "set_preferences") {
        return await handlePreferences(runtime, userId, params);
      }

      const lp = await getLpManagementService(runtime);
      if (!lp) {
        return {
          success: false,
          text: "LP management service is currently unavailable.",
        };
      }

      const rejection =
        lpWriteRejection(lp, params) ?? lpReadRejection(lp, params);
      if (rejection) {
        return { success: false, text: rejection };
      }
      await requireLpWriteSigner(runtime, userId, params);

      // GHSA-rqm7-f4jc-84x3: open/close/reposition pend for user confirmation
      // before any key derivation or DEX call, through the same gate and
      // pending-key binding as wallet router writes. Reads no-op the gate.
      const gate = await gateWalletFinancialExecution({
        runtime,
        message,
        params: lpGateParams(params),
        callback,
      });
      if (!gate.proceed) {
        return walletFinancialGateActionResult(gate);
      }

      return await handleLpOperation(runtime, lp, userId, params);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (error instanceof NoMatchingLpProtocolError) {
        return {
          success: false,
          text: errorMessage,
        };
      }
      console.error(`[LIQUIDITY] Error: ${errorMessage}`);
      return {
        success: false,
        text: `Liquidity operation failed: ${errorMessage}`,
      };
    }
  },
};
