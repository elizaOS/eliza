/**
 * WALLET_PREPARE action — non-binding preview router for swap and transfer.
 *
 * Read-only. Dispatches on `kind`:
 *   - "swap":     calls BSC trade preflight + quote (PancakeSwap / 0x).
 *   - "transfer": validates recipient + balance, surfaces a gas estimate.
 *
 * No signing, no broadcast. Use before the wallet execution router so the
 * user (or admin/owner) can review the route or recipient.
 *
 * @module actions/wallet-prepare
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  Memory,
  State,
} from "@elizaos/core";
import type {
  BscTradePreflightResponse,
  BscTradeQuoteResponse,
  BscTradeSide,
  EvmChainBalance,
  WalletAddresses,
  WalletBalancesResponse,
} from "@elizaos/shared";
import {
  buildAuthHeaders,
  getWalletActionApiPort,
} from "./wallet-action-shared.js";

/** Timeout for upstream API calls. */
const PREPARE_TIMEOUT_MS = 20_000;

/** Default slippage tolerance for prepared quotes (basis points). */
const DEFAULT_SLIPPAGE_BPS = 300;

/** Approximate native gas reserve for a BNB / token transfer (BSC). */
const APPROX_TRANSFER_GAS_BNB = "0.0005";

/** Native gas symbol for the BSC route. */
const BSC_NATIVE_SYMBOL = "BNB";

/** Matches a 0x-prefixed 40-hex-char EVM address. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type WalletPrepareKind = "swap" | "transfer";
const WALLET_PREPARE_CONTEXTS = ["finance", "crypto", "wallet", "payments"] as const;
const WALLET_PREPARE_KEYWORDS = [
  "wallet",
  "swap",
  "quote",
  "preview",
  "transfer",
  "send",
  "bnb",
  "bsc",
  "token",
  "cartera",
  "billetera",
  "intercambiar",
  "transferir",
  "enviar",
  "portefeuille",
  "échanger",
  "transférer",
  "geldbörse",
  "tauschen",
  "überweisen",
  "carteira",
  "trocar",
  "transferir",
  "portafoglio",
  "scambiare",
  "trasferire",
  "ウォレット",
  "交換",
  "送金",
  "钱包",
  "兑换",
  "转账",
  "지갑",
  "스왑",
  "전송",
] as const;

function normalizeSymbol(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.toUpperCase() === "TBNB" ? "BNB" : trimmed.toUpperCase();
}

function walletNetworkLabel(): string {
  return process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet"
    ? "BSC testnet"
    : "BSC";
}

// ── Swap helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve {fromSymbol, toSymbol} into a BSC swap side + token contract
 * address. PancakeSwap routes are denominated in BNB, so swaps must be
 * either BNB → token (buy) or token → BNB (sell).
 */
function resolveSwapPair(
  fromSymbol: string,
  toSymbol: string,
  fromAddress: string | undefined,
  toAddress: string | undefined,
):
  | {
      ok: true;
      side: BscTradeSide;
      tokenAddress: string;
    }
  | {
      ok: false;
      reason: string;
    } {
  const isFromNative = fromSymbol === BSC_NATIVE_SYMBOL;
  const isToNative = toSymbol === BSC_NATIVE_SYMBOL;

  if (isFromNative && isToNative) {
    return { ok: false, reason: "BNB → BNB is not a valid swap." };
  }

  if (isFromNative) {
    if (!toAddress || !EVM_ADDRESS_RE.test(toAddress)) {
      return {
        ok: false,
        reason: `Cannot resolve token contract address for ${toSymbol}. Provide it explicitly via toAddress.`,
      };
    }
    return { ok: true, side: "buy", tokenAddress: toAddress };
  }

  if (isToNative) {
    if (!fromAddress || !EVM_ADDRESS_RE.test(fromAddress)) {
      return {
        ok: false,
        reason: `Cannot resolve token contract address for ${fromSymbol}. Provide it explicitly via fromAddress.`,
      };
    }
    return { ok: true, side: "sell", tokenAddress: fromAddress };
  }

  return {
    ok: false,
    reason:
      "BSC swaps must be routed through BNB. One of fromSymbol or toSymbol must be BNB.",
  };
}

function formatSwapProposal(args: {
  side: BscTradeSide;
  fromSymbol: string;
  toSymbol: string;
  amount: string;
  preflight: BscTradePreflightResponse;
  quote: BscTradeQuoteResponse;
}): string {
  const lines: string[] = [];
  lines.push("Action: WALLET_PREPARE");
  lines.push("Kind: swap");
  lines.push(`Side: ${args.side}`);
  lines.push(`From: ${args.amount} ${args.fromSymbol}`);
  lines.push(
    `Expected out: ${args.quote.quoteOut.amount} ${args.quote.quoteOut.symbol}`,
  );
  lines.push(
    `Min received: ${args.quote.minReceive.amount} ${args.quote.minReceive.symbol}`,
  );
  lines.push(`Route provider: ${args.quote.routeProvider}`);
  lines.push(`Route: ${args.quote.route.join(" → ")}`);
  lines.push(`Slippage: ${args.quote.slippageBps} bps`);
  lines.push(`Price: ${args.quote.price}`);

  const checks = args.preflight.checks;
  lines.push(
    `Preflight: walletReady=${checks.walletReady} rpcReady=${checks.rpcReady} chainReady=${checks.chainReady} gasReady=${checks.gasReady}`,
  );
  if (args.preflight.reasons.length > 0) {
    lines.push(`Preflight notes: ${args.preflight.reasons.join("; ")}`);
  }
  lines.push("Executed: false");
  lines.push("This is a non-binding proposal. Use EXECUTE_TRADE to broadcast.");
  return lines.join("\n");
}

async function handleSwap(
  params: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): ReturnType<NonNullable<Action["handler"]>> {
  const fromSymbol = normalizeSymbol(params?.fromSymbol);
  const toSymbol = normalizeSymbol(params?.toSymbol);

  if (!fromSymbol || !toSymbol) {
    const text =
      "I need both fromSymbol and toSymbol (e.g. BNB and USDT) to prepare a swap.";
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  const fromAddress =
    typeof params?.fromAddress === "string"
      ? params.fromAddress.trim()
      : undefined;
  const toAddress =
    typeof params?.toAddress === "string" ? params.toAddress.trim() : undefined;

  const pair = resolveSwapPair(fromSymbol, toSymbol, fromAddress, toAddress);
  if (pair.ok === false) {
    callback?.({ text: pair.reason, action: "WALLET_PREPARE_FAILED" });
    return { text: pair.reason, success: false };
  }

  const amountRaw =
    typeof params?.amount === "string" && params.amount.trim().length > 0
      ? params.amount.trim()
      : typeof params?.amount === "number" && params.amount > 0
        ? String(params.amount)
        : undefined;

  if (
    amountRaw !== undefined &&
    (Number.isNaN(Number(amountRaw)) || Number(amountRaw) <= 0)
  ) {
    const text =
      "amount must be a positive number (in the from-asset's units).";
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  const slippageBps =
    typeof params?.slippageBps === "number"
      ? params.slippageBps
      : typeof params?.slippageBps === "string" &&
          params.slippageBps.trim().length > 0
        ? Number(params.slippageBps)
        : DEFAULT_SLIPPAGE_BPS;

  if (Number.isNaN(slippageBps) || slippageBps < 0) {
    const text = "slippageBps must be a non-negative number.";
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  // ── Preflight ─────────────────────────────────────────────────────
  const preflightResponse = await fetch(
    `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/trade/preflight`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
      body: JSON.stringify({ tokenAddress: pair.tokenAddress }),
      signal: AbortSignal.timeout(PREPARE_TIMEOUT_MS),
    },
  );

  if (!preflightResponse.ok) {
    const text = `Swap preflight failed (HTTP ${preflightResponse.status}).`;
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  const preflight =
    (await preflightResponse.json()) as BscTradePreflightResponse;

  // When no amount is supplied, return preflight-only proposal.
  if (amountRaw === undefined) {
    const lines = [
      "Action: WALLET_PREPARE",
      "Kind: swap",
      `Side: ${pair.side}`,
      `From: ${fromSymbol}`,
      `To: ${toSymbol}`,
      `Token: ${pair.tokenAddress}`,
      `Preflight: walletReady=${preflight.checks.walletReady} rpcReady=${preflight.checks.rpcReady} chainReady=${preflight.checks.chainReady} gasReady=${preflight.checks.gasReady}`,
    ];
    if (preflight.reasons.length > 0) {
      lines.push(`Preflight notes: ${preflight.reasons.join("; ")}`);
    }
    lines.push("Quote: skipped (no amount provided)");
    lines.push("Executed: false");
    const text = lines.join("\n");
    callback?.({ text, action: "WALLET_PREPARE_RESPONSE" });
    return {
      text,
      success: true,
      data: {
        kind: "swap",
        side: pair.side,
        fromSymbol,
        toSymbol,
        tokenAddress: pair.tokenAddress,
        slippageBps,
        preflight,
        executed: false,
      },
    };
  }

  // ── Quote ─────────────────────────────────────────────────────────
  const quoteResponse = await fetch(
    `http://127.0.0.1:${getWalletActionApiPort()}/api/wallet/trade/quote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
      body: JSON.stringify({
        side: pair.side,
        tokenAddress: pair.tokenAddress,
        amount: amountRaw,
        slippageBps,
      }),
      signal: AbortSignal.timeout(PREPARE_TIMEOUT_MS),
    },
  );

  if (!quoteResponse.ok) {
    const errBody = (await quoteResponse.json().catch(() => ({}))) as Record<
      string,
      string
    >;
    const text = `Swap quote failed: ${errBody.error ?? `HTTP ${quoteResponse.status}`}`;
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  const quote = (await quoteResponse.json()) as BscTradeQuoteResponse;
  if (!quote.ok) {
    const text = "Swap quote was not ok.";
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  const text = formatSwapProposal({
    side: pair.side,
    fromSymbol,
    toSymbol,
    amount: amountRaw,
    preflight,
    quote,
  });

  callback?.({ text, action: "WALLET_PREPARE_RESPONSE" });

  return {
    text,
    success: true,
    data: {
      kind: "swap",
      side: pair.side,
      fromSymbol,
      toSymbol,
      tokenAddress: pair.tokenAddress,
      amount: amountRaw,
      slippageBps: quote.slippageBps,
      routeProvider: quote.routeProvider,
      route: quote.route,
      quoteIn: quote.quoteIn,
      quoteOut: quote.quoteOut,
      minReceive: quote.minReceive,
      price: quote.price,
      preflight,
      executed: false,
    },
  };
}

// ── Transfer helpers ─────────────────────────────────────────────────────────

function findBscBalance(
  data: WalletBalancesResponse,
): EvmChainBalance | undefined {
  return data.evm?.chains.find((c) => c.chain.toLowerCase() === "bsc");
}

function resolveAvailableBalance(
  bsc: EvmChainBalance | undefined,
  assetSymbol: string,
): { found: boolean; balance: string | null; isNative: boolean } {
  if (!bsc) return { found: false, balance: null, isNative: false };

  const upper = assetSymbol.toUpperCase();
  if (upper === bsc.nativeSymbol.toUpperCase()) {
    return { found: true, balance: bsc.nativeBalance, isNative: true };
  }

  const token = bsc.tokens.find((t) => t.symbol.toUpperCase() === upper);
  if (token) {
    return { found: true, balance: token.balance, isNative: false };
  }

  return { found: false, balance: null, isNative: false };
}

function hasSufficientFunds(
  available: string | null,
  amount: string,
): boolean | null {
  if (available === null) return null;
  const av = Number(available);
  const am = Number(amount);
  if (Number.isNaN(av) || Number.isNaN(am)) return null;
  return av >= am;
}

async function handleTransfer(
  params: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): ReturnType<NonNullable<Action["handler"]>> {
  // ── Validate toAddress ─────────────────────────────────────────────
  const toAddress =
    typeof params?.toAddress === "string" ? params.toAddress.trim() : "";
  if (!toAddress || !EVM_ADDRESS_RE.test(toAddress)) {
    const text =
      "I need a valid recipient address (0x-prefixed, 40 hex chars).";
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  // ── Validate assetSymbol ───────────────────────────────────────────
  const assetSymbolRaw =
    typeof params?.assetSymbol === "string" ? params.assetSymbol.trim() : "";
  if (!assetSymbolRaw) {
    const text =
      "I need an asset symbol (e.g. BNB, USDT, USDC) for the transfer.";
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }
  if (!/^[A-Za-z0-9]{1,20}$/.test(assetSymbolRaw)) {
    const text = "Invalid asset symbol format.";
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }
  const assetSymbol =
    assetSymbolRaw.toUpperCase() === "TBNB"
      ? "BNB"
      : assetSymbolRaw.toUpperCase();

  // ── Validate amount ────────────────────────────────────────────────
  const amountRaw =
    typeof params?.amount === "string"
      ? params.amount.trim()
      : typeof params?.amount === "number"
        ? String(params.amount)
        : "";
  if (!amountRaw || Number.isNaN(Number(amountRaw)) || Number(amountRaw) <= 0) {
    const text = "I need a positive numeric amount for the transfer.";
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  // ── Fetch addresses + balances in parallel ─────────────────────────
  const port = getWalletActionApiPort();
  const [addressesResponse, balancesResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/wallet/addresses`, {
      headers: { ...buildAuthHeaders() },
      signal: AbortSignal.timeout(PREPARE_TIMEOUT_MS),
    }),
    fetch(`http://127.0.0.1:${port}/api/wallet/balances`, {
      headers: { ...buildAuthHeaders() },
      signal: AbortSignal.timeout(PREPARE_TIMEOUT_MS),
    }),
  ]);

  if (!addressesResponse.ok || !balancesResponse.ok) {
    const text = `Failed to fetch wallet state (addresses=${addressesResponse.status}, balances=${balancesResponse.status}).`;
    callback?.({ text, action: "WALLET_PREPARE_FAILED" });
    return { text, success: false };
  }

  const addresses = (await addressesResponse.json()) as WalletAddresses;
  const balances = (await balancesResponse.json()) as WalletBalancesResponse;

  const fromAddress = addresses.evmAddress;
  const bsc = findBscBalance(balances);
  const { found, balance, isNative } = resolveAvailableBalance(
    bsc,
    assetSymbol,
  );

  const sufficient = hasSufficientFunds(balance, amountRaw);
  const nativeAvailable = bsc?.nativeBalance ?? null;
  const gasSufficient =
    nativeAvailable === null
      ? null
      : Number(nativeAvailable) >= Number(APPROX_TRANSFER_GAS_BNB);

  const warnings: string[] = [];
  if (fromAddress && fromAddress.toLowerCase() === toAddress.toLowerCase()) {
    warnings.push("Recipient is the sender's own wallet address.");
  }
  if (!found) {
    warnings.push(
      `Asset ${assetSymbol} was not found in the BSC wallet balance — confirm the symbol or supply tokenAddress before executing.`,
    );
  }
  if (sufficient === false) {
    warnings.push(
      `Insufficient ${assetSymbol} balance (${balance ?? "unknown"} available, ${amountRaw} requested).`,
    );
  }
  if (gasSufficient === false) {
    warnings.push(
      `Native gas balance is below the estimated minimum (~${APPROX_TRANSFER_GAS_BNB} BNB).`,
    );
  }

  const lines: string[] = [];
  lines.push("Action: WALLET_PREPARE");
  lines.push("Kind: transfer");
  lines.push(`Chain: ${walletNetworkLabel()}`);
  lines.push(`From: ${fromAddress ?? "unknown"}`);
  lines.push(`Recipient: ${toAddress}`);
  lines.push(`Amount: ${amountRaw} ${assetSymbol}`);
  lines.push(
    `Asset type: ${found ? (isNative ? "native" : "token") : "unknown"}`,
  );
  lines.push(`Available balance: ${balance ?? "unknown"} ${assetSymbol}`);
  lines.push(
    `Sufficient funds: ${sufficient === null ? "unknown" : sufficient ? "true" : "false"}`,
  );
  lines.push(
    `Estimated gas (native): ~${APPROX_TRANSFER_GAS_BNB} ${bsc?.nativeSymbol ?? "BNB"}`,
  );
  lines.push(
    `Native gas available: ${nativeAvailable ?? "unknown"} ${bsc?.nativeSymbol ?? "BNB"}`,
  );
  if (warnings.length > 0) {
    lines.push(`Warnings: ${warnings.join(" | ")}`);
  }
  lines.push("Executed: false");
  lines.push(
    "This is a non-binding proposal. Use the wallet execution router to broadcast.",
  );

  const text = lines.join("\n");
  callback?.({ text, action: "WALLET_PREPARE_RESPONSE" });

  return {
    text,
    success: true,
    data: {
      kind: "transfer",
      fromAddress,
      toAddress,
      assetSymbol,
      amount: amountRaw,
      isNative,
      assetFound: found,
      availableBalance: balance,
      sufficientFunds: sufficient,
      estimatedGasNative: APPROX_TRANSFER_GAS_BNB,
      nativeGasAvailable: nativeAvailable,
      gasSufficient,
      warnings,
      chain: walletNetworkLabel(),
      executed: false,
    },
  };
}

// ── Action ───────────────────────────────────────────────────────────────────

function resolveKind(value: unknown): WalletPrepareKind | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "swap" || trimmed === "transfer") return trimmed;
  return undefined;
}

function hasSelectedContext(state: State | undefined): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
  collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
  const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
    | { trajectoryPrefix?: { selectedContexts?: unknown }; metadata?: { selectedContexts?: unknown } }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return WALLET_PREPARE_CONTEXTS.some((context) => selected.has(context));
}

function hasWalletPrepareIntent(message: Memory, state: State | undefined): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string" ? state.values.recentMessages : "",
  ]
    .join("\n")
    .toLowerCase();
  return WALLET_PREPARE_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

export const walletPrepareAction: Action = {
  name: "WALLET_PREPARE",
  contexts: [...WALLET_PREPARE_CONTEXTS],
  contextGate: { anyOf: [...WALLET_PREPARE_CONTEXTS] },
  roleGate: { minRole: "USER" },

  similes: [
    "PREPARE_SWAP",
    "QUOTE_SWAP",
    "PREVIEW_SWAP",
    "ESTIMATE_SWAP",
    "SWAP_QUOTE",
    "GET_SWAP_QUOTE",
    "PREVIEW_TRANSFER",
    "ESTIMATE_TRANSFER",
    "QUOTE_TRANSFER",
    "TRANSFER_PREVIEW",
  ],

  description:
    'Prepare a non-binding wallet proposal. Set kind="swap" to fetch a BSC ' +
    'swap quote (route, slippage, expected output) or kind="transfer" to ' +
    "preview a transfer (recipient validation, balance + gas check). " +
    "Read-only — does not sign or broadcast. Use before the wallet execution router.",
  descriptionCompressed: "Wallet preview ops: swap, transfer.",

  validate: async (_runtime, message: Memory, state?: State) =>
    hasSelectedContext(state) || hasWalletPrepareIntent(message, state),

  handler: async (
    _runtime,
    _message,
    _state,
    options,
    callback?: HandlerCallback,
  ) => {
    try {
      const params = (options as HandlerOptions | undefined)?.parameters;

      const kind = resolveKind(params?.kind);
      if (!kind) {
        const text = 'WALLET_PREPARE requires kind="swap" or kind="transfer".';
        callback?.({ text, action: "WALLET_PREPARE_FAILED" });
        return { text, success: false };
      }

      if (kind === "swap") return handleSwap(params, callback);
      return handleTransfer(params, callback);
    } catch (err) {
      const text = `Failed to prepare wallet operation: ${err instanceof Error ? err.message : String(err)}`;
      callback?.({ text, action: "WALLET_PREPARE_FAILED" });
      return { text, success: false };
    }
  },

  parameters: [
    {
      name: "kind",
      description:
        'Proposal kind: "swap" for a BSC swap quote, "transfer" for a token transfer preview.',
      required: true,
      schema: { type: "string" as const, enum: ["swap", "transfer"] },
    },
    // ── swap parameters ────────────────────────────────────────────────
    {
      name: "fromSymbol",
      description:
        'Source asset symbol (swap only, e.g. "BNB", "USDT"). One of fromSymbol/toSymbol must be BNB on BSC.',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "toSymbol",
      description:
        'Destination asset symbol (swap only, e.g. "BNB", "USDT"). One of fromSymbol/toSymbol must be BNB on BSC.',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "fromAddress",
      description:
        "Source token contract address (swap only — required when the source asset is not BNB).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "slippageBps",
      description:
        "Slippage tolerance in basis points (swap only, default 300 = 3%).",
      required: false,
      schema: { type: "number" as const },
    },
    // ── transfer parameters ────────────────────────────────────────────
    {
      name: "toAddress",
      description:
        "Recipient EVM address (transfer) or destination token contract address (swap, required when destination is not BNB). 0x-prefixed, 40 hex characters.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "assetSymbol",
      description:
        'Token symbol to transfer (transfer only, e.g. "BNB", "USDT", "USDC").',
      required: false,
      schema: { type: "string" as const },
    },
    // ── shared ─────────────────────────────────────────────────────────
    {
      name: "amount",
      description:
        'Human-readable amount. For swaps the source-asset units (e.g. "0.5"); for transfers the asset units (e.g. "1.5", "100").',
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
