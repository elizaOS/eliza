// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { privateKeyToAccount } from "viem/accounts";
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
      `   LP balance: ${pos.lpTokenBalance?.uiAmount?.toFixed(6) || pos.lpTokenBalance?.balance || "N/A"} ${pos.lpTokenBalance?.symbol || ""}\n`;
  });
  return response;
};

const formatPools = (pools: PoolInfo[]): string => {
  if (!pools || pools.length === 0) {
    return "No matching LP pools are registered or available.";
  }

  let response = "LP pools:\n";
  pools.slice(0, 10).forEach((pool, index) => {
    const tokenA =
      pool.tokenA?.symbol ||
      pool.tokenA?.mint ||
      pool.tokenA?.address ||
      "tokenA";
    const tokenB =
      pool.tokenB?.symbol ||
      pool.tokenB?.mint ||
      pool.tokenB?.address ||
      "tokenB";
    response +=
      `\n${index + 1}. ${pool.displayName || pool.id} on ${pool.dex}\n` +
      `   Pair: ${tokenA}/${tokenB}\n` +
      `   APR: ${pool.apr?.toFixed(2) || pool.apy?.toFixed(2) || "N/A"}%\n` +
      `   TVL: ${pool.tvl !== undefined ? `$${pool.tvl.toLocaleString()}` : "N/A"}\n`;
  });

  if (pools.length > 10) {
    response += `\nShowing 10 of ${pools.length} pools.`;
  }
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
  const contentParams = (message?.content || {}) as Record<string, unknown>;
  const params = {
    ...contentParams,
    ...(handlerParams || {}),
  } as LpActionParams & { op?: LpManagementSubaction };

  // Accept op as alias for subaction (LIQUIDITY parent uses op).
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
  const evmChain = getChainConfig(numericChain ?? chain);
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

function getEvmWallet(runtime: IAgentRuntime) {
  const rawPrivateKey = runtime.getSetting("EVM_PRIVATE_KEY");
  if (!rawPrivateKey || typeof rawPrivateKey !== "string") {
    throw new Error("EVM_PRIVATE_KEY is required for EVM LP operations.");
  }
  const privateKey = rawPrivateKey.startsWith("0x")
    ? rawPrivateKey
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
      "No LP profile found. Use subaction=onboard before managing Solana LP positions.",
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
  if (params.maxSlippageBps !== undefined || params.slippageBps !== undefined) {
    newConfig.maxSlippageBps = params.maxSlippageBps ?? params.slippageBps;
    updates.push(`maxSlippageBps=${newConfig.maxSlippageBps}`);
  }
  if (params.preferredDexes) {
    newConfig.preferredDexes = params.preferredDexes;
    updates.push(`preferredDexes=${params.preferredDexes.join(",")}`);
  }

  await profileService.updateProfile(userId, {
    autoRebalanceConfig: newConfig,
  });

  return {
    success: true,
    text: updates.length
      ? `LP preferences updated: ${updates.join(", ")}`
      : "No LP preference changes were provided.",
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
        ).filter(Boolean);
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
          ? `LP position opened on ${route.dex || "registered protocol"}. Transaction: ${result.transactionId || result.hash || "submitted"}`
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
          ? `LP position closed on ${route.dex || "registered protocol"}. Transaction: ${result.transactionId || result.hash || "submitted"}`
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
          ? `LP position repositioned on ${route.dex || "registered protocol"}. Transaction: ${result.transactionId || result.hash || "submitted"}`
          : `LP reposition failed: ${result.error || "unknown error"}`,
        data: result,
      };
    }

    default:
      return {
        success: false,
        text: `Unsupported LP subaction: ${params.subaction}`,
      };
  }
}

export const liquidityAction: Action = {
  name: "LIQUIDITY",
  contexts: ["finance", "crypto", "wallet", "automation"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "automation"] },
  roleGate: { minRole: "USER" },
  description:
    "Single LP/liquidity management action. op=onboard|list_pools|open|close|reposition|list_positions|get_position|set_preferences. dex=orca|raydium|meteora|uniswap|aerodrome|pancakeswap selects the protocol; chain=solana|evm is inferred from dex when omitted.",
  descriptionCompressed:
    "Manage LP positions by op, chain, dex, pool, position, amount, range, token filters.",
  parameters: [
    {
      name: "subaction",
      description:
        "Liquidity operation: onboard, list_pools, open, close, reposition, list_positions, get_position, set_preferences.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "onboard",
          "list_pools",
          "open",
          "close",
          "reposition",
          "list_positions",
          "get_position",
          "set_preferences",
        ],
      },
    },
    {
      name: "chain",
      description: "Chain for the LP operation.",
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
        "Pool id/address for open, close, reposition, or position lookup.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "position",
      description: "LP position id/mint/address.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "amount",
      description:
        "Liquidity amount for open, close, or reposition operations.",
      required: false,
      schema: { type: ["string", "number"] },
    },
    {
      name: "range",
      description: "Desired concentrated liquidity price range.",
      required: false,
      schema: { type: "object" },
    },
    {
      name: "tokenA",
      description: "First token filter or deposit token.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "tokenB",
      description: "Second token filter or deposit token.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "chainId",
      description: "Optional numeric EVM chain id.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "slippageBps",
      description: "Maximum allowed slippage in basis points.",
      required: false,
      schema: { type: "number" },
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
        content: { text: "Open a Raydium LP position with 100 USDC paired against SOL.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Opening the LP position.",
          actions: ["LIQUIDITY"],
          thought:
            "User wants to provide liquidity on a DEX; LIQUIDITY subaction=open with the token pair and amount routes to the LP manager.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Show my current liquidity positions.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Listing your LP positions.",
          actions: ["LIQUIDITY"],
          thought:
            "Position inventory query maps to LIQUIDITY subaction=list which returns active LP positions across pools.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Close my SOL/USDC liquidity position.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Closing the LP position.",
          actions: ["LIQUIDITY"],
          thought:
            "Withdraw / unwind intent maps to LIQUIDITY subaction=close on the named pair.",
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (!message?.content) return false;
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

  handler: async (runtime, message, _state, handlerParams) => {
    const params = normalizeParams(message, handlerParams);
    if (!params) {
      return {
        success: true,
        text: "Use LIQUIDITY with op=list_pools, open, close, reposition, list_positions, get_position, set_preferences, or onboard.",
      };
    }

    const userId = message.entityId || message.userId || "unknown-user";

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
