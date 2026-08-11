/**
 * Confirmation gate that every on-chain wallet write (`transfer`, `swap`,
 * `bridge`, `gov`, `pump_fun_buy`) and every LIQUIDITY write (`open`,
 * `close`, `reposition` in lp/actions/liquidity.ts) must pass through before
 * submission (GHSA-rqm7-f4jc-84x3). `gateWalletFinancialExecution` calls core's
 * `requireConfirmation` with a stable pending key derived from the request
 * params (`walletFinancialPendingKey`) and a human-readable preview of the
 * pending action (`walletFinancialPreview`); it only proceeds once the user
 * has replied to confirm in a later turn. `mode=execute` and `dryRun=false`
 * alone are not sufficient — the LLM cannot bypass this gate by setting
 * request params, since confirmation state lives in runtime cache and is
 * keyed off the actual transfer/swap/bridge parameters, not caller-supplied
 * flags. `dryRun=true` requests skip the gate entirely (no signing occurs).
 * Do not remove or short-circuit this gate from calling code.
 */
import type {
  ActionResult,
  ConfirmationDecision,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { requireConfirmation } from "@elizaos/core";
import type { WalletRouterParams } from "../types/wallet-router.js";
import { ON_CHAIN_WRITE_SUBACTIONS } from "./wallet-context-safety.js";

/** Cache namespace for on-chain wallet writes (GHSA-rqm7-f4jc-84x3). */
export const WALLET_FINANCIAL_CONFIRM_ACTION = "WALLET_FINANCIAL";

// Alias of the single source in wallet-context-safety.ts: this gate fires for
// exactly the on-chain write subactions, so the two gates cannot diverge.
export const ON_CHAIN_SUBACTIONS = ON_CHAIN_WRITE_SUBACTIONS;

// The gate's parameter shape: the wallet router's params plus the LP write
// identifiers (pool/position/dex/range/tokens/feeTier). `subaction` is
// widened to string so the LIQUIDITY write subactions (open/close/reposition),
// which never route through the wallet router's Zod enum, flow through the
// same gate. LP-owned fields bind the confirmation pending key so a "yes"
// cannot authorize a different dex/range/pair than the user confirmed.
export type WalletFinancialWriteParams = Omit<
  WalletRouterParams,
  "subaction"
> & {
  readonly subaction: string;
  readonly pool?: string;
  readonly position?: string;
  readonly dex?: string;
  readonly tokenA?: string;
  readonly tokenB?: string;
  readonly feeTier?: number;
  readonly range?: {
    readonly tickLower?: number;
    readonly tickUpper?: number;
    readonly tickLowerIndex?: number;
    readonly tickUpperIndex?: number;
    readonly priceLower?: number;
    readonly priceUpper?: number;
  };
};

/** Stable serialization of LP range bounds for pending-key binding. */
export function walletFinancialRangeKey(
  range: WalletFinancialWriteParams["range"],
): string {
  if (!range) return "";
  const tickLower = range.tickLowerIndex ?? range.tickLower;
  const tickUpper = range.tickUpperIndex ?? range.tickUpper;
  const parts: string[] = [];
  if (tickLower !== undefined) parts.push(`tl=${tickLower}`);
  if (tickUpper !== undefined) parts.push(`tu=${tickUpper}`);
  if (range.priceLower !== undefined) parts.push(`pl=${range.priceLower}`);
  if (range.priceUpper !== undefined) parts.push(`pu=${range.priceUpper}`);
  return parts.join(",");
}

export function requiresWalletFinancialConfirmation(
  params: Pick<WalletFinancialWriteParams, "subaction" | "dryRun">,
): boolean {
  if (params.dryRun) {
    return false;
  }
  return ON_CHAIN_SUBACTIONS.has(params.subaction);
}

export function walletFinancialPendingKey(
  params: Pick<
    WalletFinancialWriteParams,
    | "subaction"
    | "chain"
    | "toChain"
    | "amount"
    | "recipient"
    | "fromToken"
    | "toToken"
    | "slippageBps"
    | "op"
    | "governor"
    | "proposalId"
    | "pool"
    | "position"
    | "dex"
    | "tokenA"
    | "tokenB"
    | "feeTier"
    | "range"
  >,
): string {
  const entries: [string, string][] = [
    ["subaction", params.subaction],
    ["chain", (params.chain ?? "").toLowerCase()],
    ["toChain", (params.toChain ?? "").toLowerCase()],
    ["amount", params.amount ?? ""],
    ["recipient", (params.recipient ?? "").toLowerCase()],
    ["fromToken", (params.fromToken ?? "").toLowerCase()],
    ["toToken", (params.toToken ?? "").toLowerCase()],
    [
      "slippageBps",
      params.slippageBps === undefined ? "" : String(params.slippageBps),
    ],
    ["op", (params.op ?? "").toLowerCase()],
    ["governor", (params.governor ?? "").toLowerCase()],
    ["proposalId", params.proposalId ?? ""],
  ];
  // LP identifiers bind only when present so existing wallet pending keys
  // keep their exact shape; pool/position stay case-sensitive because Solana
  // mints and position ids are base58. dex/range/tokens/feeTier bind the LP
  // economic parameters so a confirmation cannot be replayed onto a
  // different protocol or range for the same pool id.
  if (params.pool !== undefined) {
    entries.push(["pool", params.pool]);
  }
  if (params.position !== undefined) {
    entries.push(["position", params.position]);
  }
  if (params.dex !== undefined) {
    entries.push(["dex", params.dex.toLowerCase()]);
  }
  if (params.tokenA !== undefined) {
    entries.push(["tokenA", params.tokenA.toLowerCase()]);
  }
  if (params.tokenB !== undefined) {
    entries.push(["tokenB", params.tokenB.toLowerCase()]);
  }
  if (params.feeTier !== undefined) {
    entries.push(["feeTier", String(params.feeTier)]);
  }
  const rangeKey = walletFinancialRangeKey(params.range);
  if (rangeKey) {
    entries.push(["range", rangeKey]);
  }
  return entries.map(([key, value]) => `${key}=${value}`).join("|");
}

// The authorized slippage is part of what the user confirms, so the prompt
// must disclose it: without it a 10 bps and a 10,000 bps swap read
// identically. The unstated default is not a single chain-agnostic number
// (EVM swaps escalate 1% -> 1.5% -> 2%, bridges hold 1%, Solana uses dynamic
// slippage), so it is labeled rather than numbered.
function slippagePreviewClause(slippageBps: number | undefined): string {
  if (slippageBps === undefined) {
    return " with default slippage";
  }
  return ` with up to ${slippageBps / 100}% slippage (${slippageBps} bps)`;
}

export function walletFinancialPreview(
  params: Pick<
    WalletFinancialWriteParams,
    | "subaction"
    | "chain"
    | "toChain"
    | "amount"
    | "recipient"
    | "fromToken"
    | "toToken"
    | "slippageBps"
    | "op"
    | "pool"
    | "position"
    | "dex"
    | "tokenA"
    | "tokenB"
    | "feeTier"
    | "range"
  >,
): string {
  const chainLabel = params.chain ?? params.toChain ?? "the selected chain";
  const dexClause = params.dex ? ` via ${params.dex}` : "";
  const pairClause =
    params.tokenA || params.tokenB
      ? ` (${params.tokenA ?? "?"}/${params.tokenB ?? "?"})`
      : "";
  const feeClause =
    params.feeTier === undefined ? "" : ` feeTier=${params.feeTier}`;
  const rangeClause = (() => {
    const key = walletFinancialRangeKey(params.range);
    return key ? ` range ${key}` : "";
  })();
  const slippage = slippagePreviewClause(params.slippageBps);
  switch (params.subaction) {
    case "transfer":
      return `Transfer ${params.amount ?? "?"} ${params.fromToken ?? "tokens"} to ${params.recipient ?? "?"} on ${chainLabel}? Reply yes to submit or no to cancel.`;
    case "swap":
      return `Swap ${params.amount ?? "?"} ${params.fromToken ?? "?"} to ${params.toToken ?? "?"} on ${chainLabel}${slippage}? Reply yes to submit or no to cancel.`;
    case "bridge": {
      // params.recipient becomes the Li.Fi destination toAddress, so the user
      // must see it before confirming; with no recipient the bridge returns
      // funds to the sender on the destination chain.
      const destination = params.recipient ? ` to ${params.recipient}` : "";
      return `Bridge ${params.amount ?? "?"} ${params.fromToken ?? "?"} from ${params.chain ?? "?"} to ${params.toChain ?? "?"}${destination}${slippage}? Reply yes to submit or no to cancel.`;
    }
    case "gov":
      return `Governance ${params.op ?? "operation"} on ${chainLabel}? Reply yes to submit or no to cancel.`;
    case "pump_fun_buy":
      return `Buy ${params.amount ?? "?"} SOL of ${params.toToken ?? "the selected pump.fun token"} through pump.fun on ${chainLabel}? Reply yes to submit or no to cancel.`;
    case "open":
      return `Open a liquidity position in pool ${params.pool ?? "?"}${pairClause}${dexClause} on ${chainLabel}${feeClause}${rangeClause} with ${params.amount ?? "?"}? Reply yes to submit or no to cancel.`;
    case "close":
    case "reposition": {
      const poolClause = params.pool ? ` in pool ${params.pool}` : "";
      const verb = params.subaction === "close" ? "Close" : "Reposition";
      const repositionExtras =
        params.subaction === "reposition"
          ? `${dexClause}${feeClause}${rangeClause}`
          : dexClause;
      return `${verb} liquidity position ${params.position ?? "?"}${poolClause}${pairClause}${repositionExtras} on ${chainLabel}? Reply yes to submit or no to cancel.`;
    }
    default:
      return `Submit wallet ${params.subaction} on ${chainLabel}? Reply yes to confirm or no to cancel.`;
  }
}

export type WalletFinancialGateResult =
  | { readonly proceed: true }
  | {
      readonly proceed: false;
      readonly decision: ConfirmationDecision;
      readonly text: string;
    };

export async function gateWalletFinancialExecution(args: {
  runtime: IAgentRuntime;
  message: Memory;
  params: WalletFinancialWriteParams;
  callback?: HandlerCallback;
}): Promise<WalletFinancialGateResult> {
  if (!requiresWalletFinancialConfirmation(args.params)) {
    return { proceed: true };
  }

  const decision = await requireConfirmation({
    runtime: args.runtime,
    message: args.message,
    actionName: WALLET_FINANCIAL_CONFIRM_ACTION,
    pendingKey: walletFinancialPendingKey(args.params),
    prompt: walletFinancialPreview(args.params),
    callback: args.callback,
    metadata: { subaction: args.params.subaction },
  });

  if (decision.status === "confirmed") {
    return { proceed: true };
  }

  const text =
    decision.status === "pending"
      ? walletFinancialPreview(args.params)
      : "Wallet operation cancelled.";

  return { proceed: false, decision, text };
}

export function walletFinancialGateActionResult(
  gate: Extract<WalletFinancialGateResult, { proceed: false }>,
): ActionResult {
  const awaiting = gate.decision.status === "pending";
  return {
    success: awaiting,
    text: gate.text,
    values: {
      walletActionPrepared: awaiting,
      walletActionSucceeded: false,
    },
    data: {
      requiresConfirmation: awaiting,
      confirmationStatus: gate.decision.status,
      awaitingUserInput: awaiting,
    },
  };
}
