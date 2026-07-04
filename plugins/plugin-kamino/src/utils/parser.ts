import {
  IAgentRuntime,
  JSONSchema,
  Memory,
  ModelType,
  State,
} from "@elizaos/core";
import type {
  DepositParams,
  BorrowParams,
  RepayParams,
  WithdrawParams,
} from "../types/index";

// ─── LendParams (mirror of DepositParams, kept separate for clarity) ──────────

export type LendParams = DepositParams;

// ─── Known token symbols ──────────────────────────────────────────────────────
// Extend this list as more reserves are added to the Kamino markets.
const KNOWN_TOKENS = [
  "SOL", "USDC", "USDT", "ETH", "BTC", "WBTC", "mSOL", "JitoSOL",
  "BSOL", "stSOL", "JLP", "PYUSD", "USDH", "CHAI", "BONK", "WIF",
  "ORCA", "RAY", "SRM", "MNGO", "SAMO", "STEP", "COPE",
];

/**
 * Fast regex-based extraction. Handles the majority of user messages like:
 *   "Deposit 1 SOL as collateral"  →  { token: "SOL", amount: "1" }
 *   "Borrow 100.5 USDC"            →  { token: "USDC", amount: "100.5" }
 *   "repay max USDC"               →  { token: "USDC", amount: "max" }
 * Returns null when it can't confidently extract both fields.
 */
function regexExtract(
  text: string,
  allowMax = false,
): { token: string; amount: string } | null {
  const t = text.trim();

  // Build alternation of known tokens (case-insensitive)
  const tokenAlt = KNOWN_TOKENS.join("|");
  const amountPat = allowMax
    ? "(?:max|all|everything|full|[0-9]+(?:\\.[0-9]+)?)"
    : "[0-9]+(?:\\.[0-9]+)?";

  // Pattern: <amount> <token>  e.g. "100 USDC", "1.5 SOL"
  const fwdMatch = t.match(
    new RegExp(`(${amountPat})\\s+(${tokenAlt})`, "i"),
  );
  if (fwdMatch) {
    return {
      amount: fwdMatch[1].toLowerCase() === "max" ? "max" : fwdMatch[1],
      token: fwdMatch[2].toUpperCase(),
    };
  }

  // Pattern: <token> <amount>  e.g. "SOL 1"
  const revMatch = t.match(
    new RegExp(`(${tokenAlt})\\s+(${amountPat})`, "i"),
  );
  if (revMatch) {
    return {
      token: revMatch[1].toUpperCase(),
      amount: revMatch[2].toLowerCase() === "max" ? "max" : revMatch[2],
    };
  }

  return null;
}

// ─── Shared internal factory ──────────────────────────────────────────────────
// Falls back to LLM only when regex can't extract the params.

async function runObjectModel(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  template: string,
  schema: JSONSchema,
  allowMax = false,
): Promise<Record<string, unknown> | null> {
  // 1. Try fast regex extraction from the raw user message first.
  //    This avoids the {{recentMessages}} confusion that happens when the
  //    action handler runs after the agent has already replied.
  const userText = message.content.text ?? "";
  const regexResult = regexExtract(userText, allowMax);
  if (regexResult) {
    return {
      token: regexResult.token,
      amount: regexResult.amount,
      marketName: "main",
    };
  }

  // 2. LLM fallback — embed the raw user text directly in the prompt so the
  //    model sees only what the user typed, not the full conversation history.
  try {
    const directPrompt = template
      .replace("{{recentMessages}}", userText)
      .replace("{{providers}}", "");

    const result = (await runtime.useModel(ModelType.OBJECT_SMALL, {
      prompt: directPrompt,
      schema,
    })) as Record<string, unknown>;
    return result ?? null;
  } catch {
    return null;
  }
}


// ─── Base schema (token + amount + marketName) ────────────────────────────────

const BASE_SCHEMA = {
  type: "object",
  properties: {
    token: { type: "string" },
    amount: { type: "string" }, // kept as string — Decimal() in action
    marketName: { type: "string" },
  },
  required: ["token", "amount"],
};

// Same but amount also accepts the literal "max"
const MAX_SCHEMA = {
  type: "object",
  properties: {
    token: { type: "string" },
    amount: { type: "string" }, // "max" or a numeric string
    marketName: { type: "string" },
  },
  required: ["token", "amount"],
};

// ─── parseLendMessage ─────────────────────────────────────────────────────────
// Used by: buildLendTxns (KaminoAction.buildDepositReserveLiquidityTxns)
// Supplies tokens into the reserve to earn interest — pure lending, no collateral.

const LEND_TEMPLATE = `
{{providers}}

Extract lending/supply parameters from the user message below.
The user wants to supply or lend tokens into Kamino to earn interest.
If the market is not specified, default to "main".

User message: "{{recentMessages}}"

Return JSON with:
- token: string  (e.g. "USDC", "SOL", "USDT")
- amount: string (numeric string, e.g. "100", "0.5")
- marketName: string (default "main")
`.trim();

export async function parseLendMessage(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): Promise<LendParams | null> {
  const result = await runObjectModel(
    runtime,
    message,
    state,
    LEND_TEMPLATE,
    BASE_SCHEMA,
  );
  if (!result) return null;

  return {
    token: String(result.token).toUpperCase(),
    amount: String(result.amount),
    marketName: String(result.marketName ?? "main"),
  };
}

// ─── parseLendWithdrawMessage ─────────────────────────────────────────────────
// Used by: buildLendWithdrawTxns (KaminoAction.buildRedeemReserveCollateralTxns)
// Redeems cTokens from a lending position to get the underlying back.

const LEND_WITHDRAW_TEMPLATE = `
{{providers}}

Extract lend-withdrawal parameters from the user message below.
The user wants to withdraw tokens they previously supplied/lent to Kamino.
If the market is not specified, default to "main".
If the user says "all", "everything", or "max", set amount to "max".

User message: "{{recentMessages}}"

Return JSON with:
- token: string  (e.g. "USDC", "SOL")
- amount: string ("max" or a numeric string like "100")
- marketName: string (default "main")
`.trim();

export async function parseLendWithdrawMessage(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): Promise<WithdrawParams | null> {
  const result = await runObjectModel(
    runtime,
    message,
    state,
    LEND_WITHDRAW_TEMPLATE,
    MAX_SCHEMA,
    true,
  );
  if (!result) return null;

  return {
    token: String(result.token).toUpperCase(),
    amount: String(result.amount), // may be "max"
    marketName: String(result.marketName ?? "main"),
  };
}

// ─── parseDepositMessage ──────────────────────────────────────────────────────
// Used by: buildDepositTxns (KaminoAction.buildDepositTxns / VanillaObligation)
// Deposits collateral into a vanilla obligation to enable borrowing.

const DEPOSIT_TEMPLATE = `
{{providers}}

Extract collateral deposit parameters from the user message below.
The user wants to deposit tokens as collateral into Kamino to borrow against them.
If the market is not specified, default to "main".

User message: "{{recentMessages}}"

Return JSON with:
- token: string  (e.g. "SOL", "USDC")
- amount: string (numeric string, e.g. "5", "100")
- marketName: string (default "main")
`.trim();

export async function parseDepositMessage(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): Promise<DepositParams | null> {
  const result = await runObjectModel(
    runtime,
    message,
    state,
    DEPOSIT_TEMPLATE,
    BASE_SCHEMA,
  );
  if (!result) return null;

  return {
    token: String(result.token).toUpperCase(),
    amount: String(result.amount),
    marketName: String(result.marketName ?? "main"),
  };
}

// ─── parseBorrowMessage ───────────────────────────────────────────────────────
// Used by: buildBorrowTxns (KaminoAction.buildBorrowTxns / VanillaObligation)
// Borrows tokens from the market against existing collateral.

const BORROW_TEMPLATE = `
{{providers}}

Extract borrow parameters from the user message below.
The user wants to take a loan from Kamino against their deposited collateral.
If the market is not specified, default to "main".

User message: "{{recentMessages}}"

Return JSON with:
- token: string      (e.g. "USDC", "SOL")
- amount: string     (numeric string)
- marketName: string (default "main")
`.trim();

export async function parseBorrowMessage(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): Promise<BorrowParams | null> {
  const result = await runObjectModel(
    runtime,
    message,
    state,
    BORROW_TEMPLATE,
    BASE_SCHEMA,
  );
  if (!result) return null;

  return {
    token: String(result.token).toUpperCase(),
    amount: String(result.amount),
    marketName: String(result.marketName ?? "main"),
  };
}

// ─── parseRepayMessage ────────────────────────────────────────────────────────
// Used by: buildRepayTxns (KaminoAction.buildRepayTxns / VanillaObligation)
// Repays borrowed tokens back to the market.

const REPAY_TEMPLATE = `
{{providers}}

Extract repay parameters from the user message below.
The user wants to repay a loan or debt on Kamino.
If the market is not specified, default to "main".
If the user says "all", "everything", "full", or "max", set amount to "max".

User message: "{{recentMessages}}"

Return JSON with:
- token: string      (e.g. "USDC", "SOL")
- amount: string     (numeric string)
- marketName: string (default "main")
`.trim();

export async function parseRepayMessage(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): Promise<RepayParams | null> {
  const result = await runObjectModel(
    runtime,
    message,
    state,
    REPAY_TEMPLATE,
    MAX_SCHEMA,
    true,
  );
  if (!result) return null;

  return {
    token: String(result.token).toUpperCase(),
    amount: String(result.amount),
    marketName: String(result.marketName ?? "main"),
  };
}

// ─── parseWithdrawMessage ─────────────────────────────────────────────────────
// Used by: buildWithdrawTxns (KaminoAction.buildWithdrawTxns / VanillaObligation)
// Withdraws deposited collateral from a vanilla obligation.

const WITHDRAW_TEMPLATE = `
{{providers}}

Extract collateral withdrawal parameters from the user message below.
The user wants to withdraw collateral they previously deposited into Kamino.
If the market is not specified, default to "main".
If the user says "all", "everything", "full", or "max", set amount to "max".

User message: "{{recentMessages}}"

Return JSON with:
- token: string      (e.g. "USDC", "SOL")
- amount: string     (numeric string)
- marketName: string (default "main")
`.trim();

export async function parseWithdrawMessage(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): Promise<WithdrawParams | null> {
  const result = await runObjectModel(
    runtime,
    message,
    state,
    WITHDRAW_TEMPLATE,
    MAX_SCHEMA,
    true,
  );
  if (!result) return null;

  return {
    token: String(result.token).toUpperCase(),
    amount: String(result.amount),
    marketName: String(result.marketName ?? "main"),
  };
}
