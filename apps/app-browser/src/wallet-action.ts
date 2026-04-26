import {
  approveStewardWalletRequest,
  getStewardWalletUnavailableMessage,
  rejectStewardWalletRequest,
  signWithStewardWallet,
  type StewardSignResponse,
} from "@elizaos/app-steward";
import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";

type StewardSignActionRequest = {
  to: string;
  value: string;
  chainId: number;
  data?: string;
  description?: string;
  broadcast?: boolean;
};

type StewardApprovalRequest = {
  txId: string;
  reason?: string;
};

const ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/;
const CHAIN_ID_RE = /\bchain(?:\s*id)?\s*:?\s*(\d+)\b/i;
const DATA_RE = /\b(?:data|calldata)\s*:?\s*(0x[a-fA-F0-9]+)\b/i;
const TX_ID_RE = /\b(tx[\w:-]+)\b/i;
const VALUE_RE = /\bvalue(?:\s*\(wei\))?\s*:?\s*(\d+)\b/i;

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getChainName(chainId: number): string {
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 56:
      return "BSC";
    case 137:
      return "Polygon";
    case 8453:
      return "Base";
    case 42161:
      return "Arbitrum";
    default:
      return `chain ${chainId}`;
  }
}

function formatViolations(
  violations: StewardSignResponse["violations"] | undefined,
): string {
  if (!Array.isArray(violations) || violations.length === 0) {
    return "Steward denied the request.";
  }

  return `Steward denied the request: ${violations
    .map((entry) => `${entry.policy} (${entry.reason})`)
    .join("; ")}`;
}

function parseSignRequest(
  message: Memory,
  options?: HandlerOptions,
): StewardSignActionRequest | null {
  const text = getMessageText(message);
  const params = (options?.parameters ?? {}) as Record<string, unknown>;
  const to =
    normalizeString(params.to) ?? text.match(ADDRESS_RE)?.[0] ?? undefined;
  const value =
    normalizeString(params.value) ?? text.match(VALUE_RE)?.[1] ?? undefined;
  const chainId =
    normalizeNumber(params.chainId) ??
    (text.match(CHAIN_ID_RE)?.[1]
      ? Number(text.match(CHAIN_ID_RE)?.[1])
      : undefined);
  const data =
    normalizeString(params.data) ?? text.match(DATA_RE)?.[1] ?? undefined;
  const description = normalizeString(params.description);
  const broadcast = normalizeBoolean(params.broadcast);

  if (!to || !value || !chainId || chainId <= 0) {
    return null;
  }

  return {
    to,
    value,
    chainId,
    data,
    description,
    broadcast,
  };
}

function parseApprovalRequest(
  message: Memory,
  options?: HandlerOptions,
): StewardApprovalRequest | null {
  const text = getMessageText(message);
  const params = (options?.parameters ?? {}) as Record<string, unknown>;
  const txId =
    normalizeString(params.txId) ??
    normalizeString(params.id) ??
    text.match(TX_ID_RE)?.[1] ??
    undefined;
  if (!txId) {
    return null;
  }

  const reasonFromParams = normalizeString(params.reason);
  const reasonMatch = text.match(/\breason\s*:?\s*(.+)$/i);
  const becauseMatch = text.match(/\bbecause\s+(.+)$/i);

  return {
    txId,
    reason:
      reasonFromParams ?? becauseMatch?.[1]?.trim() ?? reasonMatch?.[1]?.trim(),
  };
}

export const signWithElizaWalletAction: Action = {
  name: "SIGN_WITH_ELIZA_WALLET",
  description:
    "Send a transaction through the Eliza Steward-managed wallet while browsing. Use this when the user or agent needs the Eliza wallet to sign and optionally broadcast a transaction.",
  descriptionCompressed:
    "Send transaction through Eliza Steward wallet while browsing.",
  similes: [
    "sign transaction with wallet",
    "send with steward wallet",
    "queue wallet signature",
  ],
  parameters: [
    {
      name: "to",
      description: "Destination EVM address for the transaction.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "value",
      description: "Transaction value in wei.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "chainId",
      description: "Numeric EVM chain ID.",
      required: true,
      schema: { type: "number" },
    },
    {
      name: "data",
      description: "Optional calldata hex string.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "description",
      description: "Optional human-readable reason for the signing request.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "broadcast",
      description:
        "Whether Steward should broadcast the transaction after signing.",
      required: false,
      schema: { type: "boolean", default: true },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    options?: HandlerOptions,
  ) =>
    parseSignRequest(message, options) !== null ||
    /\b(sign|wallet|transaction|steward|broadcast|approve)\b/i.test(
      getMessageText(message),
    ),
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ) => {
    const request = parseSignRequest(message, options);
    if (!request) {
      const text =
        "Could not determine the signing request. Provide to, value, and chainId explicitly.";
      await callback?.({ text });
      return { success: false, text };
    }

    try {
      const result = await signWithStewardWallet(request);
      const chainName = getChainName(request.chainId);
      const text = result.approved
        ? `Signed and broadcast the ${chainName} transaction${result.txHash ? `: ${result.txHash}` : "."}`
        : result.pending
          ? `Queued the ${chainName} transaction for approval. Request ID: ${result.txId ?? "unknown"}.`
          : formatViolations(result.violations);
      await callback?.({ text });
      return { success: result.approved || result.pending === true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await callback?.({ text });
      return { success: false, text };
    }
  },
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Use the Eliza wallet to send 1000000000000000 wei to 0xabc0000000000000000000000000000000000000 on chain 8453",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Queued the Base transaction for approval. Request ID: tx_123.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const approveElizaWalletRequestAction: Action = {
  name: "APPROVE_ELIZA_WALLET_REQUEST",
  description:
    "Approve a pending Eliza Steward wallet request by transaction/request ID.",
  similes: ["approve wallet request", "approve steward request"],
  parameters: [
    {
      name: "txId",
      description: "Pending Steward request ID to approve.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    options?: HandlerOptions,
  ) =>
    parseApprovalRequest(message, options) !== null ||
    /\bapprove\b.*\b(wallet|request|transaction|steward)\b/i.test(
      getMessageText(message),
    ),
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ) => {
    const request = parseApprovalRequest(message, options);
    if (!request) {
      const text = "Could not determine which Steward request to approve.";
      await callback?.({ text });
      return { success: false, text };
    }

    try {
      const result = await approveStewardWalletRequest(request.txId);
      const text = result.txHash?.trim()
        ? `Approved Steward request ${request.txId}. Broadcast hash: ${result.txHash}`
        : `Approved Steward request ${request.txId}.`;
      await callback?.({ text });
      return { success: true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await callback?.({ text });
      return { success: false, text };
    }
  },
};

export const rejectElizaWalletRequestAction: Action = {
  name: "REJECT_ELIZA_WALLET_REQUEST",
  description:
    "Reject a pending Eliza Steward wallet request by transaction/request ID.",
  similes: ["reject wallet request", "deny steward request"],
  parameters: [
    {
      name: "txId",
      description: "Pending Steward request ID to reject.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "reason",
      description: "Optional explanation for rejecting the request.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    options?: HandlerOptions,
  ) =>
    parseApprovalRequest(message, options) !== null ||
    /\b(reject|deny)\b.*\b(wallet|request|transaction|steward)\b/i.test(
      getMessageText(message),
    ),
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ) => {
    const request = parseApprovalRequest(message, options);
    if (!request) {
      const text = "Could not determine which Steward request to reject.";
      await callback?.({ text });
      return { success: false, text };
    }

    try {
      await rejectStewardWalletRequest(request.txId, request.reason);
      const text = request.reason
        ? `Rejected Steward request ${request.txId}: ${request.reason}`
        : `Rejected Steward request ${request.txId}.`;
      await callback?.({ text });
      return { success: true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await callback?.({ text });
      return { success: false, text };
    }
  },
};

export const elizaWalletUnavailableMessage =
  getStewardWalletUnavailableMessage();
