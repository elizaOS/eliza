import type { Memory } from "@elizaos/core";

/** GHSA-7qxr-x6cg-r9cc — embedded addresses in token metadata must not become transfer recipients. */
/** GHSA-gh63-5vpj-39qp — block financial writes on injection-flagged channel messages. */

const FINANCIAL_WRITE_SUBACTIONS = new Set(["transfer", "swap", "bridge"]);

function messageHasPromptInjectionFlag(message: Memory): boolean {
  const metadata = message.content?.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as { promptInjectionSuspected?: boolean }).promptInjectionSuspected ===
      true
  );
}
export const EVM_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}\b/g;

const INFERRED_RECIPIENT_PHRASE =
  /\b(?:prior\s+wallet\s+evidence|operational\s+recipient|canonical\s+(?:testnet\s+)?(?:operational|settlement)\s+recipient|based\s+on\s+(?:the\s+)?prior|from\s+prior\s+(?:wallet|session|context))\b/i;

export function sanitizeWalletDisplayLabel(label: string): string {
  return label
    .replace(EVM_ADDRESS_PATTERN, "[address]")
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
      "Wallet transfer, swap, and bridge are blocked for this message (GHSA-gh63-5vpj-39qp): suspected prompt injection in untrusted channel content.",
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
