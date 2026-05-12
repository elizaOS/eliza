/**
 * BSC trade preflight + quote helpers.
 *
 * Safety-first scope:
 * - No execution/signing here.
 * - Validate wallet/rpc/chain/gas/token before producing a quote.
 */

import type {
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeRoutePreference,
  BscTradeRouteProvider,
  BscTradeSide,
  BscUnsignedApprovalTx,
  BscUnsignedTradeTx,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
<<<<<<< HEAD
import { ethers } from "ethers";
=======
import * as ethers from "ethers";
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
import {
  normalizeRpcUrl,
  resolveBscRpcUrls as resolveWalletBscRpcUrls,
  resolveWalletNetworkMode,
} from "./wallet-rpc";

const FETCH_TIMEOUT_MS = 15_000;
const BSC_MAINNET_CHAIN_ID = 56;
const BSC_TESTNET_CHAIN_ID = 97;
const MIN_GAS_BNB = "0.005";
const DEFAULT_SLIPPAGE_BPS = 300;
const MAX_SLIPPAGE_BPS = 1_000;
const SLIPPAGE_WARNING_THRESHOLD_BPS = 300;
const ZEROX_API_BASE_URL = "https://bsc.api.0x.org";
const ZEROX_QUOTE_TIMEOUT_MS = 8_000;

export const PANCAKE_SWAP_V2_ROUTER = ethers.getAddress(
  "0x10ED43C718714eb63d5aA57B78B54704E256024E",
);
export const BSC_WBNB_FALLBACK = ethers.getAddress(
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
);
export const BSC_TESTNET_EXPLORER_BASE_URL = "https://testnet.bscscan.com";

const ROUTER_IFACE = new ethers.Interface([
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
]);

const ERC20_IFACE = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export interface BscTradeRpcConfig {
  rpcUrls?: string[] | null;
  nodeRealBscRpcUrl?: string | null;
  quickNodeBscRpcUrl?: string | null;
  bscRpcUrl?: string | null;
  cloudManagedAccess?: boolean | null;
}

export interface BuildBscTradePreflightInput extends BscTradeRpcConfig {
  walletAddress: string | null;
  tokenAddress?: string | null;
}

export interface BuildBscTradeQuoteInput extends BscTradeRpcConfig {
  walletAddress: string | null;
  request: BscTradeQuoteRequest;
}

interface RpcCallResult<T> {
  result: T;
  rpcUrl: string;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
}

interface ZeroXQuoteResponse {
  to?: string;
  data?: string;
  value?: string;
  allowanceTarget?: string;
  buyAmount?: string;
  sellAmount?: string;
}

interface BscExecutionContext {
  walletNetwork: "mainnet" | "testnet";
  chainId: number;
  routerAddress: string;
  wrappedNativeFallback: string | null;
  explorerBaseUrl: string;
}

function resolveBscExecutionContext(): BscExecutionContext {
  const walletNetwork = resolveWalletNetworkMode();
  if (walletNetwork === "mainnet") {
    return {
      walletNetwork,
      chainId: BSC_MAINNET_CHAIN_ID,
      routerAddress: PANCAKE_SWAP_V2_ROUTER,
      wrappedNativeFallback: BSC_WBNB_FALLBACK,
      explorerBaseUrl: "https://bscscan.com",
    };
  }

  const configuredChainIdRaw = process.env.BSC_TESTNET_CHAIN_ID?.trim();
  const configuredChainId = configuredChainIdRaw
    ? Number.parseInt(configuredChainIdRaw, 10)
    : BSC_TESTNET_CHAIN_ID;
  const chainId =
    Number.isFinite(configuredChainId) && configuredChainId > 0
      ? configuredChainId
      : BSC_TESTNET_CHAIN_ID;

  const routerAddress = normalizeAddress(
    process.env.BSC_TESTNET_SWAP_ROUTER_ADDRESS ??
      process.env.BSC_SWAP_ROUTER_ADDRESS,
  );
  if (!routerAddress) {
    throw new Error(
      "BSC testnet router not configured. Set BSC_TESTNET_SWAP_ROUTER_ADDRESS.",
    );
  }
  const wrappedNativeFallback = normalizeAddress(
    process.env.BSC_TESTNET_WRAPPED_NATIVE_ADDRESS ??
      process.env.BSC_WRAPPED_NATIVE_ADDRESS,
  );

  const explorerBaseUrlRaw =
    process.env.BSC_TESTNET_EXPLORER_BASE_URL ?? BSC_TESTNET_EXPLORER_BASE_URL;
  const explorerBaseUrl = (() => {
    try {
      const parsed = new URL(explorerBaseUrlRaw);
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      return BSC_TESTNET_EXPLORER_BASE_URL;
    }
  })();

  return {
    walletNetwork,
    chainId,
    routerAddress,
    wrappedNativeFallback,
    explorerBaseUrl,
  };
}

export function resolveBscRpcUrls(input: BscTradeRpcConfig): string[] {
  const walletNetwork = resolveWalletNetworkMode();
  const candidates = [
    ...(input.rpcUrls ?? []).map((url) => normalizeRpcUrl(url)),
    normalizeRpcUrl(process.env.BSC_TESTNET_RPC_URL),
    normalizeRpcUrl(
      input.nodeRealBscRpcUrl !== undefined
        ? input.nodeRealBscRpcUrl
        : process.env.NODEREAL_BSC_RPC_URL,
    ),
    normalizeRpcUrl(
      input.quickNodeBscRpcUrl !== undefined
        ? input.quickNodeBscRpcUrl
        : process.env.QUICKNODE_BSC_RPC_URL,
    ),
    // Standard plugin env key used across elizaOS EVM tooling.
    normalizeRpcUrl(
      input.bscRpcUrl !== undefined ? input.bscRpcUrl : process.env.BSC_RPC_URL,
    ),
    ...resolveWalletBscRpcUrls({
      cloudManagedAccess: input.cloudManagedAccess,
      walletNetwork,
    }),
  ].filter((v): v is string => Boolean(v));

  return [...new Set(candidates)];
}

export function resolvePrimaryBscRpcUrl(
  input: BscTradeRpcConfig,
): string | null {
  const urls = resolveBscRpcUrls(input);
  if (urls.length === 0) return null;
  const primary = urls[0];
  try {
    const parsed = new URL(primary);
    if (parsed.protocol === "http:") {
      logger.warn(
        `BSC RPC URL uses http: (${parsed.host}) — MITM risk for trade execution. Use https: in production.`,
      );
    }
  } catch {
    // URL parsing failed; normalizeRpcUrl already validated it, so this shouldn't happen
  }
  return primary;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return ethers.getAddress(trimmed);
  } catch {
    return null;
  }
}

function parseRpcChainId(value: string): number | null {
  if (!value || typeof value !== "string") return null;
  if (!value.startsWith("0x")) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampSlippageBps(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SLIPPAGE_BPS;
  }
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > MAX_SLIPPAGE_BPS) {
    console.warn(
      `[bsc-trade] Slippage ${rounded} bps exceeds max ${MAX_SLIPPAGE_BPS} bps, clamping`,
    );
    return MAX_SLIPPAGE_BPS;
  }
  if (rounded > SLIPPAGE_WARNING_THRESHOLD_BPS) {
    console.warn(
      `[bsc-trade] High slippage requested: ${rounded} bps (${(rounded / 100).toFixed(1)}%)`,
    );
  }
  return rounded;
}

function clampDeadlineSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 600;
  const rounded = Math.round(value);
  if (rounded < 60) return 60;
  if (rounded > 3600) return 3600;
  return rounded;
}

function parsePositiveDecimal(value: string): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be a positive number.");
  }
  return amount;
}

function resolveRouteProviderPreference(
  value: string | null | undefined,
): BscTradeRoutePreference {
  if (value === "pancakeswap-v2" || value === "0x" || value === "auto") {
    return value;
  }
  return "auto";
}

function resolveRouteProviderOrder(
  requested: BscTradeRoutePreference,
): BscTradeRouteProvider[] {
  if (requested === "0x") {
    return ["0x", "pancakeswap-v2"];
  }
  if (requested === "pancakeswap-v2") {
    return ["pancakeswap-v2"];
  }
  return ["0x", "pancakeswap-v2"];
}

function formatPrice(amountIn: string, amountOut: string): string {
  const inNum = Number.parseFloat(amountIn);
  const outNum = Number.parseFloat(amountOut);
  if (!Number.isFinite(inNum) || !Number.isFinite(outNum) || inNum <= 0) {
    return "0";
  }
  const price = outNum / inNum;
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.001) return price.toFixed(6);
  return price.toExponential(4);
}

async function rpcCallWithFallback<T>(
  rpcUrls: string[],
  method: string,
  params: unknown[],
): Promise<RpcCallResult<T>> {
  if (rpcUrls.length === 0) {
    throw new Error("No BSC RPC endpoints configured.");
  }

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  let lastError = "Unknown RPC error";
  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        body: payload,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${raw.slice(0, 180)}`);
      }
      let parsed: JsonRpcResponse<T>;
      try {
        parsed = JSON.parse(raw) as JsonRpcResponse<T>;
      } catch {
        throw new Error(`Invalid JSON response: ${raw.slice(0, 180)}`);
      }
      if (parsed.error) {
        throw new Error(
          parsed.error.message ?? `RPC error ${parsed.error.code}`,
        );
      }
      if (parsed.result === undefined || parsed.result === null) {
        throw new Error("RPC returned empty result.");
      }
      return { result: parsed.result, rpcUrl };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = `${hostLabel(rpcUrl)}: ${message}`;
    }
  }

  throw new Error(lastError);
}

async function ethCall(
  rpcUrls: string[],
  to: string,
  data: string,
): Promise<RpcCallResult<string>> {
  return rpcCallWithFallback<string>(rpcUrls, "eth_call", [
    { to, data },
    "latest",
  ]);
}

async function readWrappedNativeAddress(
  rpcUrls: string[],
  context: BscExecutionContext,
): Promise<string> {
  const encoded = ROUTER_IFACE.encodeFunctionData("WETH", []);
  try {
    const call = await ethCall(rpcUrls, context.routerAddress, encoded);
    const decoded = ROUTER_IFACE.decodeFunctionResult("WETH", call.result);
    const wrappedNative = decoded[0];

    if (typeof wrappedNative !== "string" || !wrappedNative) {
      throw new Error("Router WETH() returned an invalid address.");
    }

    return ethers.getAddress(wrappedNative);
  } catch (err) {
    if (context.wrappedNativeFallback) {
      return context.wrappedNativeFallback;
    }
    throw err;
  }
}

export async function readTokenDecimals(
  rpcUrls: string[],
  tokenAddress: string,
): Promise<number> {
  const encoded = ERC20_IFACE.encodeFunctionData("decimals", []);
  const call = await ethCall(rpcUrls, tokenAddress, encoded);
  const decoded = ERC20_IFACE.decodeFunctionResult("decimals", call.result);
  const decimals = decoded[0];

  if (typeof decimals !== "bigint") return 18;

  const parsed = Number(decimals);
  if (!Number.isFinite(parsed) || parsed < 0) return 18;

  return parsed;
}

async function readTokenSymbol(
  rpcUrls: string[],
  tokenAddress: string,
): Promise<string> {
  const encoded = ERC20_IFACE.encodeFunctionData("symbol", []);
  const call = await ethCall(rpcUrls, tokenAddress, encoded);
  const decoded = ERC20_IFACE.decodeFunctionResult("symbol", call.result);
  const symbol = decoded[0];

  if (typeof symbol === "string" && symbol.trim()) {
    return symbol.trim().slice(0, 16);
  }

  return `TKN-${tokenAddress.slice(2, 6).toUpperCase()}`;
}

async function readTokenBalanceWei(
  rpcUrls: string[],
  tokenAddress: string,
  walletAddress: string,
): Promise<bigint> {
  const encoded = ERC20_IFACE.encodeFunctionData("balanceOf", [walletAddress]);
  const call = await ethCall(rpcUrls, tokenAddress, encoded);
  const decoded = ERC20_IFACE.decodeFunctionResult("balanceOf", call.result);
  const balance = decoded[0];
  if (typeof balance !== "bigint") {
    throw new Error("Token balance response is invalid.");
  }
  return balance;
}

async function fetchZeroXQuote(input: {
  side: BscTradeSide;
  walletAddress: string;
  tokenAddress: string;
  wrappedNativeAddress: string;
  amountInWei: bigint;
  slippageBps: number;
}): Promise<ZeroXQuoteResponse> {
  const apiBase = normalizeRpcUrl(process.env.ZEROX_BSC_API_BASE_URL)
    ? (normalizeRpcUrl(process.env.ZEROX_BSC_API_BASE_URL) as string)
    : ZEROX_API_BASE_URL;
  const sellToken =
    input.side === "buy" ? input.wrappedNativeAddress : input.tokenAddress;
  const buyToken =
    input.side === "buy" ? input.tokenAddress : input.wrappedNativeAddress;
  const quoteUrl = new URL("/swap/v1/quote", apiBase);
  quoteUrl.searchParams.set("sellToken", sellToken);
  quoteUrl.searchParams.set("buyToken", buyToken);
  quoteUrl.searchParams.set("sellAmount", input.amountInWei.toString());
  quoteUrl.searchParams.set(
    "slippagePercentage",
    (input.slippageBps / 10_000).toString(),
  );
  quoteUrl.searchParams.set("takerAddress", input.walletAddress);
  const apiKey = process.env.ZEROX_API_KEY?.trim();
  const response = await fetch(quoteUrl.toString(), {
    method: "GET",
    headers: apiKey ? { "0x-api-key": apiKey } : undefined,
    signal: AbortSignal.timeout(ZEROX_QUOTE_TIMEOUT_MS),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`0x HTTP ${response.status}: ${raw.slice(0, 180)}`);
  }
  let parsed: ZeroXQuoteResponse;
  try {
    parsed = JSON.parse(raw) as ZeroXQuoteResponse;
  } catch {
    throw new Error(`0x quote returned invalid JSON: ${raw.slice(0, 180)}`);
  }

  const to = normalizeAddress(parsed.to);
  const data =
    typeof parsed.data === "string" && parsed.data.startsWith("0x")
      ? parsed.data
      : null;
  const buyAmount =
    typeof parsed.buyAmount === "string" && /^\d+$/.test(parsed.buyAmount)
      ? BigInt(parsed.buyAmount)
      : null;
  const sellAmount =
    typeof parsed.sellAmount === "string" && /^\d+$/.test(parsed.sellAmount)
      ? BigInt(parsed.sellAmount)
      : null;
  const value =
    typeof parsed.value === "string" && /^\d+$/.test(parsed.value)
      ? parsed.value
      : "0";

  if (!to || !data || !buyAmount || !sellAmount) {
    throw new Error("0x quote missing required transaction fields.");
  }

  return {
    to,
    data,
    value,
    allowanceTarget:
      normalizeAddress(parsed.allowanceTarget ?? null) ?? undefined,
    buyAmount: buyAmount.toString(),
    sellAmount: sellAmount.toString(),
  };
}

export async function buildBscTradePreflight(
  input: BuildBscTradePreflightInput,
): Promise<BscTradePreflightResponse> {
  const context = resolveBscExecutionContext();
  const checks = {
    walletReady: false,
    rpcReady: false,
    chainReady: false,
    gasReady: false,
    tokenAddressValid: true,
  };
  const reasons: string[] = [];
  const walletAddress = normalizeAddress(input.walletAddress);
  const tokenAddressRaw = (input.tokenAddress ?? "").trim();
  const tokenAddress = tokenAddressRaw
    ? normalizeAddress(tokenAddressRaw)
    : null;
  const rpcUrls = resolveBscRpcUrls(input);

  let chainId: number | null = null;
  let bnbBalance: string | null = null;
  let activeRpcUrl: string | null = null;

  checks.walletReady = Boolean(walletAddress);
  if (!checks.walletReady) {
    reasons.push("Wallet not ready. Create or connect an EVM wallet first.");
  }

  if (tokenAddressRaw && !tokenAddress) {
    checks.tokenAddressValid = false;
    reasons.push("Token address format is invalid.");
  }

  if (rpcUrls.length === 0) {
    reasons.push(
      "BSC RPC not configured. Connect Eliza Cloud or set NODEREAL_BSC_RPC_URL, QUICKNODE_BSC_RPC_URL, or BSC_RPC_URL.",
    );
  } else {
    try {
      const chainResponse = await rpcCallWithFallback<string>(
        rpcUrls,
        "eth_chainId",
        [],
      );
      activeRpcUrl = chainResponse.rpcUrl;
      checks.rpcReady = true;
      chainId = parseRpcChainId(chainResponse.result);
      checks.chainReady = chainId === context.chainId;
      if (!checks.chainReady) {
        reasons.push(
          chainId === null
            ? "Unable to read chain id from RPC."
            : `RPC chain mismatch. Expected BSC (${context.chainId}), got ${chainId}.`,
        );
      }
    } catch (err) {
      reasons.push(
        `BSC RPC unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (checks.walletReady && checks.rpcReady) {
    try {
      const rpcCandidates = activeRpcUrl
        ? [activeRpcUrl, ...rpcUrls.filter((url) => url !== activeRpcUrl)]
        : rpcUrls;
      const balanceResponse = await rpcCallWithFallback<string>(
        rpcCandidates,
        "eth_getBalance",
        [walletAddress, "latest"],
      );
      if (!activeRpcUrl) activeRpcUrl = balanceResponse.rpcUrl;
      const balanceWei = BigInt(balanceResponse.result);
      bnbBalance = ethers.formatEther(balanceWei);
      checks.gasReady = balanceWei >= ethers.parseEther(MIN_GAS_BNB);
      if (!checks.gasReady) {
        reasons.push(
          `Insufficient BNB gas. Keep at least ${MIN_GAS_BNB} BNB available.`,
        );
      }
    } catch (err) {
      reasons.push(
        `Failed to read wallet balance: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (tokenAddressRaw && tokenAddress && checks.rpcReady && checks.chainReady) {
    try {
      const rpcCandidates = activeRpcUrl
        ? [activeRpcUrl, ...rpcUrls.filter((url) => url !== activeRpcUrl)]
        : rpcUrls;
      const codeResponse = await rpcCallWithFallback<string>(
        rpcCandidates,
        "eth_getCode",
        [tokenAddress, "latest"],
      );
      if (!activeRpcUrl) activeRpcUrl = codeResponse.rpcUrl;
      const code = codeResponse.result.trim().toLowerCase();
      if (code === "0x" || code === "0x0") {
        checks.tokenAddressValid = false;
        reasons.push("Token contract not found on BSC.");
      }
    } catch (err) {
      checks.tokenAddressValid = false;
      reasons.push(
        `Token contract check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const ok =
    checks.walletReady &&
    checks.rpcReady &&
    checks.chainReady &&
    checks.gasReady &&
    checks.tokenAddressValid;

  return {
    ok,
    walletAddress,
    rpcUrlHost: activeRpcUrl ? hostLabel(activeRpcUrl) : null,
    chainId,
    bnbBalance,
    minGasBnb: MIN_GAS_BNB,
    checks,
    reasons,
  };
}

export async function buildBscTradeQuote(
  input: BuildBscTradeQuoteInput,
): Promise<BscTradeQuoteResponse> {
  const context = resolveBscExecutionContext();
  const side = input.request.side as BscTradeSide;
  if (side !== "buy" && side !== "sell") {
    throw new Error('Unsupported trade side. Use "buy" or "sell".');
  }

  const tokenAddress = normalizeAddress(input.request.tokenAddress);
  if (!tokenAddress) {
    throw new Error("Token address is required.");
  }

  const amountInput = input.request.amount.trim();
  parsePositiveDecimal(amountInput);

  const slippageBps = clampSlippageBps(input.request.slippageBps);
  const routeProviderRequested = resolveRouteProviderPreference(
    input.request.routeProvider,
  );
  const preflight = await buildBscTradePreflight({
    walletAddress: input.walletAddress,
    tokenAddress,
    rpcUrls: input.rpcUrls,
    nodeRealBscRpcUrl: input.nodeRealBscRpcUrl,
    quickNodeBscRpcUrl: input.quickNodeBscRpcUrl,
    bscRpcUrl: input.bscRpcUrl,
    cloudManagedAccess: input.cloudManagedAccess,
  });
  if (!preflight.ok) {
    throw new Error(preflight.reasons[0] ?? "Trade preflight failed.");
  }

  const rpcUrls = resolveBscRpcUrls(input);
  if (rpcUrls.length === 0) {
    throw new Error("BSC RPC unavailable.");
  }

  const wrappedNativeAddress = await readWrappedNativeAddress(rpcUrls, context);
  const tokenDecimals = await readTokenDecimals(rpcUrls, tokenAddress);
  const tokenSymbol = await readTokenSymbol(rpcUrls, tokenAddress);

  const amountInWei =
    side === "buy"
      ? ethers.parseEther(amountInput)
      : ethers.parseUnits(amountInput, tokenDecimals);

  if (side === "sell") {
    if (!preflight.walletAddress) {
      throw new Error("Wallet not ready for sell quote.");
    }
    const tokenBalanceWei = await readTokenBalanceWei(
      rpcUrls,
      tokenAddress,
      preflight.walletAddress,
    );
    if (amountInWei > tokenBalanceWei) {
      throw new Error("Insufficient token balance for sell amount.");
    }
  }

  if (side === "buy" && preflight.bnbBalance) {
    const walletBalanceWei = ethers.parseEther(preflight.bnbBalance);
    const gasReserveWei = ethers.parseEther(MIN_GAS_BNB);
    if (amountInWei + gasReserveWei > walletBalanceWei) {
      throw new Error(
        `Insufficient BNB for amount + gas reserve (${MIN_GAS_BNB} BNB).`,
      );
    }
  }

  let routeProvider: BscTradeRouteProvider = "pancakeswap-v2";
  let routeProviderFallbackUsed = false;
  const routeProviderNotes: string[] = [];
  let amountOutWei: bigint | null = null;
  let route: string[] = [];
  let swapTargetAddress: string | undefined;
  let swapCallData: string | undefined;
  let swapValueWei: string | undefined;
  let allowanceTarget: string | undefined;

  const providerErrors: string[] = [];
  for (const provider of resolveRouteProviderOrder(routeProviderRequested)) {
    try {
      if (provider === "0x") {
        if (!preflight.walletAddress) {
          throw new Error("wallet address is required for 0x route");
        }
        const zeroX = await fetchZeroXQuote({
          side,
          walletAddress: preflight.walletAddress,
          tokenAddress,
          wrappedNativeAddress,
          amountInWei,
          slippageBps,
        });
        const buyAmount = BigInt(zeroX.buyAmount ?? "0");
        if (buyAmount <= 0n) {
          throw new Error("0x quote returned zero output amount");
        }
        amountOutWei = buyAmount;
        routeProvider = "0x";
        route =
          side === "buy"
            ? [wrappedNativeAddress, tokenAddress]
            : [tokenAddress, wrappedNativeAddress];
        swapTargetAddress = zeroX.to;
        swapCallData = zeroX.data;
        swapValueWei = zeroX.value ?? "0";
        allowanceTarget = zeroX.allowanceTarget;
        break;
      }

      const candidateRoute =
        side === "buy"
          ? [wrappedNativeAddress, tokenAddress]
          : [tokenAddress, wrappedNativeAddress];
      const quoteCall = ROUTER_IFACE.encodeFunctionData("getAmountsOut", [
        amountInWei,
        candidateRoute,
      ]);
      const quoteResponse = await ethCall(
        rpcUrls,
        context.routerAddress,
        quoteCall,
      );
      const decoded = ROUTER_IFACE.decodeFunctionResult(
        "getAmountsOut",
        quoteResponse.result,
      );
      const amountsOut = decoded[0];
      if (!Array.isArray(amountsOut) || amountsOut.length < 2) {
        throw new Error("router returned an invalid quote");
      }
      const finalAmount = amountsOut[amountsOut.length - 1];
      if (typeof finalAmount !== "bigint" || finalAmount <= 0n) {
        throw new Error("router quote output is invalid");
      }

      amountOutWei = finalAmount;
      routeProvider = "pancakeswap-v2";
      route = candidateRoute;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      providerErrors.push(`${provider}: ${message}`);
    }
  }

  if (!amountOutWei) {
    throw new Error(
      `Trade quote failed across providers (${providerErrors.join(" | ")})`,
    );
  }

  if (routeProviderRequested !== routeProvider) {
    routeProviderFallbackUsed = true;
    routeProviderNotes.push(
      `Requested ${routeProviderRequested}, used ${routeProvider}.`,
    );
  }
  if (providerErrors.length > 0) {
    routeProviderNotes.push(...providerErrors);
  }

  let minReceiveWei = (amountOutWei * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minReceiveWei === 0n && amountOutWei > 0n) {
    minReceiveWei = 1n;
  }
  const outDecimals = side === "buy" ? tokenDecimals : 18;
  const inSymbol = side === "buy" ? "BNB" : tokenSymbol;
  const outSymbol = side === "buy" ? tokenSymbol : "BNB";
  const amountInFormatted =
    side === "buy"
      ? ethers.formatEther(amountInWei)
      : ethers.formatUnits(amountInWei, tokenDecimals);
  const amountOutFormatted = ethers.formatUnits(amountOutWei, outDecimals);
  const minReceiveFormatted = ethers.formatUnits(minReceiveWei, outDecimals);

  return {
    ok: true,
    side,
    routeProvider,
    routeProviderRequested,
    routeProviderFallbackUsed,
    routeProviderNotes:
      routeProviderNotes.length > 0 ? routeProviderNotes : undefined,
    routerAddress:
      routeProvider === "0x"
        ? (swapTargetAddress ?? context.routerAddress)
        : context.routerAddress,
    wrappedNativeAddress,
    tokenAddress,
    slippageBps,
    route,
    quoteIn: {
      symbol: inSymbol,
      amount: amountInFormatted,
      amountWei: amountInWei.toString(),
    },
    quoteOut: {
      symbol: outSymbol,
      amount: amountOutFormatted,
      amountWei: amountOutWei.toString(),
    },
    minReceive: {
      symbol: outSymbol,
      amount: minReceiveFormatted,
      amountWei: minReceiveWei.toString(),
    },
    price: formatPrice(amountInFormatted, amountOutFormatted),
    preflight,
    swapTargetAddress,
    swapCallData,
    swapValueWei,
    allowanceTarget,
    quotedAt: Date.now(),
  };
}

/**
 * Assert that the quote's routerAddress matches the expected PancakeSwap V2 router.
 * Prevents a compromised or tampered quote from directing funds to an arbitrary address.
 */
function assertRouterAddress(
  quote: BscTradeQuoteResponse,
  context: BscExecutionContext,
): void {
  if (quote.routeProvider === "0x") {
    return;
  }
  if (quote.routerAddress !== context.routerAddress) {
    throw new Error(
      `Unexpected router address in quote: ${quote.routerAddress}. Expected router ${context.routerAddress}.`,
    );
  }
}

export function buildBscBuyUnsignedTx(
  quote: BscTradeQuoteResponse,
  recipientAddress: string | null,
  deadlineSeconds?: number,
): BscUnsignedTradeTx {
  const context = resolveBscExecutionContext();
  assertRouterAddress(quote, context);
  if (quote.side !== "buy") {
    throw new Error("Only buy execution is currently supported.");
  }
  const normalizedRecipient = normalizeAddress(recipientAddress);
  if (!normalizedRecipient) {
    throw new Error("Recipient wallet address is required.");
  }
  if (quote.routeProvider === "0x") {
    if (!quote.swapTargetAddress || !quote.swapCallData) {
      throw new Error("0x quote is missing swap transaction payload.");
    }
    return {
      chainId: context.chainId,
      from: normalizedRecipient,
      to: quote.swapTargetAddress,
      data: quote.swapCallData,
      valueWei: quote.swapValueWei ?? quote.quoteIn.amountWei,
      deadline:
        Math.floor(Date.now() / 1000) + clampDeadlineSeconds(deadlineSeconds),
      explorerUrl: context.explorerBaseUrl,
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + clampDeadlineSeconds(deadlineSeconds);
  const data = ROUTER_IFACE.encodeFunctionData(
    "swapExactETHForTokensSupportingFeeOnTransferTokens",
    [
      BigInt(quote.minReceive.amountWei),
      quote.route,
      normalizedRecipient,
      deadline,
    ],
  );

  return {
    chainId: context.chainId,
    from: normalizedRecipient,
    to: quote.routerAddress,
    data,
    valueWei: quote.quoteIn.amountWei,
    deadline,
    explorerUrl: context.explorerBaseUrl,
  };
}

export function buildBscSellUnsignedTx(
  quote: BscTradeQuoteResponse,
  recipientAddress: string | null,
  deadlineSeconds?: number,
): BscUnsignedTradeTx {
  const context = resolveBscExecutionContext();
  assertRouterAddress(quote, context);
  if (quote.side !== "sell") {
    throw new Error("Only sell execution is supported for this payload.");
  }
  const normalizedRecipient = normalizeAddress(recipientAddress);
  if (!normalizedRecipient) {
    throw new Error("Recipient wallet address is required.");
  }
  if (quote.routeProvider === "0x") {
    if (!quote.swapTargetAddress || !quote.swapCallData) {
      throw new Error("0x quote is missing swap transaction payload.");
    }
    return {
      chainId: context.chainId,
      from: normalizedRecipient,
      to: quote.swapTargetAddress,
      data: quote.swapCallData,
      valueWei: quote.swapValueWei ?? "0",
      deadline:
        Math.floor(Date.now() / 1000) + clampDeadlineSeconds(deadlineSeconds),
      explorerUrl: context.explorerBaseUrl,
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + clampDeadlineSeconds(deadlineSeconds);
  const data = ROUTER_IFACE.encodeFunctionData(
    "swapExactTokensForETHSupportingFeeOnTransferTokens",
    [
      BigInt(quote.quoteIn.amountWei),
      BigInt(quote.minReceive.amountWei),
      quote.route,
      normalizedRecipient,
      deadline,
    ],
  );

  return {
    chainId: context.chainId,
    from: normalizedRecipient,
    to: quote.routerAddress,
    data,
    valueWei: "0",
    deadline,
    explorerUrl: context.explorerBaseUrl,
  };
}

export function buildBscApproveUnsignedTx(
  tokenAddress: string,
  ownerAddress: string | null,
  spenderAddress: string,
  amountWei: string,
): BscUnsignedApprovalTx {
  const context = resolveBscExecutionContext();
  const normalizedToken = normalizeAddress(tokenAddress);
  if (!normalizedToken) {
    throw new Error("Token address is invalid for approval payload.");
  }
  const normalizedOwner = normalizeAddress(ownerAddress);
  if (!normalizedOwner) {
    throw new Error("Owner wallet address is required for approval payload.");
  }
  const normalizedSpender = normalizeAddress(spenderAddress);
  if (!normalizedSpender) {
    throw new Error("Spender address is invalid for approval payload.");
  }
  let amount: bigint;
  try {
    amount = BigInt(amountWei);
  } catch {
    throw new Error(
      `Invalid approval amount: expected integer string, got "${String(amountWei).slice(0, 20)}"`,
    );
  }
  if (amount <= 0n) {
    throw new Error("Approval amount must be greater than zero.");
  }
  const data = ERC20_IFACE.encodeFunctionData("approve", [
    normalizedSpender,
    amount,
  ]);

  return {
    chainId: context.chainId,
    from: normalizedOwner,
    to: normalizedToken,
    data,
    valueWei: "0",
    explorerUrl: context.explorerBaseUrl,
    spender: normalizedSpender,
    amountWei: amount.toString(),
  };
}

export function resolveBscApprovalSpender(
  quote: Pick<
    BscTradeQuoteResponse,
    "routeProvider" | "allowanceTarget" | "routerAddress"
  >,
): string {
  if (quote.routeProvider === "0x" && quote.allowanceTarget) {
    return quote.allowanceTarget;
  }
  return quote.routerAddress;
}
