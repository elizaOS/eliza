/**
 * Confirmation gate that every on-chain wallet write (`transfer`, `swap`,
 * `bridge`, `gov`, `pump_fun_buy`) must pass through before submission
 * (GHSA-rqm7-f4jc-84x3). `gateWalletFinancialExecution` calls core's
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

/** Cache namespace for on-chain wallet writes (GHSA-rqm7-f4jc-84x3). */
export const WALLET_FINANCIAL_CONFIRM_ACTION = "WALLET_FINANCIAL";

const ON_CHAIN_SUBACTIONS = new Set<WalletRouterParams["subaction"]>([
  "transfer",
  "swap",
  "bridge",
  "gov",
  "pump_fun_buy",
]);

export function requiresWalletFinancialConfirmation(
  params: Pick<WalletRouterParams, "subaction" | "dryRun">,
): boolean {
  if (params.dryRun) {
    return false;
  }
  return ON_CHAIN_SUBACTIONS.has(params.subaction);
}

export function walletFinancialPendingKey(
  params: Pick<
    WalletRouterParams,
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
  return entries.map(([key, value]) => `${key}=${value}`).join("|");
}

export function walletFinancialPreview(
  params: Pick<
    WalletRouterParams,
    | "subaction"
    | "chain"
    | "toChain"
    | "amount"
    | "recipient"
    | "fromToken"
    | "toToken"
    | "op"
  >,
): string {
  const chainLabel = params.chain ?? params.toChain ?? "the selected chain";
  switch (params.subaction) {
    case "transfer":
      return `Transfer ${params.amount ?? "?"} ${params.fromToken ?? "tokens"} to ${params.recipient ?? "?"} on ${chainLabel}? Reply yes to submit or no to cancel.`;
    case "swap":
      return `Swap ${params.amount ?? "?"} ${params.fromToken ?? "?"} to ${params.toToken ?? "?"} on ${chainLabel}? Reply yes to submit or no to cancel.`;
    case "bridge":
      return `Bridge ${params.amount ?? "?"} from ${params.chain ?? "?"} to ${params.toChain ?? "?"}? Reply yes to submit or no to cancel.`;
    case "gov":
      return `Governance ${params.op ?? "operation"} on ${chainLabel}? Reply yes to submit or no to cancel.`;
    case "pump_fun_buy":
      return `Buy ${params.amount ?? "?"} SOL of ${params.toToken ?? "the selected pump.fun token"} through pump.fun on ${chainLabel}? Reply yes to submit or no to cancel.`;
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
  params: WalletRouterParams;
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
