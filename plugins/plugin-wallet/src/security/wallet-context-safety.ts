/**
 * Security guards that stand between untrusted message/channel content and
 * on-chain financial writes. `assertWalletFinancialActionAllowed` blocks
 * transfer/swap/bridge/pump_fun_buy subactions, governance votes, LIQUIDITY
 * open/close/reposition writes, and steward TRADE order submission when core
 * has flagged the inbound message as suspected prompt injection
 * (GHSA-gh63-5vpj-39qp).
 * `assertEvmTransferRecipientAuthorized` / `messageAuthorizesEvmRecipient`
 * and the Solana equivalents `assertSolanaTransferRecipientAuthorized` /
 * `messageAuthorizesSolanaRecipient` enforce that a transfer recipient (EVM
 * or Solana) was explicitly stated by the user, in message text or structured
 * action parameters, rather than inferred from token metadata, prior session
 * context, or other embedded addresses (GHSA-7qxr-x6cg-r9cc).
 * `sanitizeWalletDisplayLabel` strips embedded EVM and Solana addresses plus
 * routing-hint phrases before untrusted labels are ever shown back to the
 * user. These are load-bearing security checks: do not weaken or bypass them
 * from calling code.
 */
import type { Memory } from "@elizaos/core";

/** GHSA-7qxr-x6cg-r9cc: embedded addresses in token metadata must not become transfer recipients. */
/** GHSA-gh63-5vpj-39qp: block financial writes on injection-flagged channel messages. */

// Single source of truth for on-chain write subactions. Every on-chain write
// subaction must be in this set: the confirmation gate in
// wallet-financial-confirmation.ts fires for exactly these subactions, and the
// injection guard below adds "trade" (which carries its own confirmation
// prompt in trade-action.ts), so a newly added subaction can never be covered
// by one gate and missed by the other again.
export const ON_CHAIN_WRITE_SUBACTIONS: ReadonlySet<string> = new Set([
  "transfer",
  "swap",
  "bridge",
  "pump_fun_buy",
  // governance votes/delegations are on-chain writes; an injected message must not
  // drive them any more than it may drive a transfer
  "gov",
  // LP-owned verbs from lp/actions/liquidity.ts (not wallet-router Zod
  // enums). They move the same vault funds through DEX adapters and route
  // through both gates. Do not reuse these names on the wallet router without
  // namespacing — a future router `close` would inherit injection-block +
  // mandatory confirmation.
  "open",
  "close",
  "reposition",
]);

export const FINANCIAL_WRITE_SUBACTIONS: ReadonlySet<string> = new Set([
  ...ON_CHAIN_WRITE_SUBACTIONS,
  // steward TRADE order submission routes through trade-action.ts, not the wallet
  // router, but is the same class of financial write
  "trade",
]);

function messageHasPromptInjectionFlag(message: Memory): boolean {
  const metadata = message.content?.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as { promptInjectionSuspected?: boolean })
      .promptInjectionSuspected === true
  );
}
export const EVM_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}\b/g;
export const SOLANA_ADDRESS_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SOLANA_ADDRESS_EXACT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const INFERRED_RECIPIENT_PHRASE =
  /\b(?:prior\s+wallet\s+evidence|operational\s+recipient|canonical\s+(?:testnet\s+)?(?:operational|settlement)\s+recipient|based\s+on\s+(?:the\s+)?prior|from\s+prior\s+(?:wallet|session|context))\b/i;

export function sanitizeWalletDisplayLabel(label: string): string {
  return label
    .replace(EVM_ADDRESS_PATTERN, "[address]")
    .replace(SOLANA_ADDRESS_PATTERN, "[address]")
    .replace(
      /\[[^\]]*(?:recipient|operational|settlement|canonical)[^\]]*\]/gi,
      "[routing-hint-removed]",
    )
    .trim();
}

export function readMemoryText(message: Memory): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (
    message.content &&
    typeof message.content === "object" &&
    typeof message.content.text === "string"
  ) {
    return message.content.text;
  }
  return "";
}

function collectExplicitRecipients(
  options: Record<string, unknown> | undefined,
): string[] {
  const out: string[] = [];
  const params =
    options &&
    typeof options === "object" &&
    "parameters" in options &&
    options.parameters &&
    typeof options.parameters === "object"
      ? (options.parameters as Record<string, unknown>)
      : null;

  for (const source of [params, options]) {
    if (!source) continue;
    for (const key of ["recipient", "toAddress", "to"] as const) {
      const value = source[key];
      if (typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)) {
        out.push(value.toLowerCase());
      } else if (
        typeof value === "string" &&
        SOLANA_ADDRESS_EXACT.test(value)
      ) {
        out.push(value);
      }
    }
  }
  return out;
}

export function messageAuthorizesEvmRecipient(
  message: Memory,
  options: Record<string, unknown> | undefined,
  recipient: string,
): boolean {
  const normalized = recipient.toLowerCase();
  const explicit = collectExplicitRecipients(options);
  if (explicit.includes(normalized)) {
    return true;
  }

  const userText = readMemoryText(message);
  if (userText.toLowerCase().includes(normalized)) {
    return true;
  }

  return false;
}

export function assertWalletFinancialActionAllowed(
  message: Memory,
  subaction: string | undefined,
): void {
  if (!subaction || !FINANCIAL_WRITE_SUBACTIONS.has(subaction)) {
    return;
  }
  if (messageHasPromptInjectionFlag(message)) {
    throw new Error(
      "Wallet transfers, swaps, bridges, pump.fun buys, governance votes, liquidity operations, and trade orders are blocked for this message (GHSA-gh63-5vpj-39qp): suspected prompt injection in untrusted channel content.",
    );
  }
}

export function messageAuthorizesSolanaRecipient(
  message: Memory,
  options: Record<string, unknown> | undefined,
  recipient: string,
): boolean {
  const explicit = collectExplicitRecipients(options);
  if (explicit.includes(recipient)) {
    return true;
  }

  const userText = readMemoryText(message);
  if (userText.includes(recipient)) {
    return true;
  }

  return false;
}

export function assertSolanaTransferRecipientAuthorized(
  message: Memory,
  options: Record<string, unknown> | undefined,
  recipient: string,
): void {
  if (!SOLANA_ADDRESS_EXACT.test(recipient)) {
    throw new Error("recipient must be a valid Solana base58 address.");
  }

  const userText = readMemoryText(message);
  if (
    INFERRED_RECIPIENT_PHRASE.test(userText) &&
    !messageAuthorizesSolanaRecipient(message, options, recipient)
  ) {
    throw new Error(
      "Transfer recipient cannot be inferred from prior wallet context or token metadata. Provide an explicit base58 recipient address in this message or in structured action parameters.",
    );
  }

  if (!messageAuthorizesSolanaRecipient(message, options, recipient)) {
    throw new Error(
      "Transfer recipient must appear explicitly in the current user message or structured action parameters. Addresses from token names or earlier session quotes are not accepted.",
    );
  }
}

export function assertEvmTransferRecipientAuthorized(
  message: Memory,
  options: Record<string, unknown> | undefined,
  recipient: string,
): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    throw new Error("recipient must be a valid EVM address.");
  }

  const userText = readMemoryText(message);
  if (
    INFERRED_RECIPIENT_PHRASE.test(userText) &&
    !messageAuthorizesEvmRecipient(message, options, recipient)
  ) {
    throw new Error(
      "Transfer recipient cannot be inferred from prior wallet context or token metadata. Provide an explicit 0x recipient address in this message or in structured action parameters.",
    );
  }

  if (!messageAuthorizesEvmRecipient(message, options, recipient)) {
    throw new Error(
      "Transfer recipient must appear explicitly in the current user message or structured action parameters. Addresses from token names or earlier session quotes are not accepted.",
    );
  }
}
