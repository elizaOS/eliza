import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
  ProviderValue,
  State,
} from "@elizaos/core";
import {
  WALLET_BACKEND_SERVICE_TYPE,
  type WalletBackendService,
} from "../services/wallet-backend-service.js";
import type {
  WalletRouterFailure,
  WalletRouterParams,
  WalletRouterResult,
  WalletRouterSubaction,
} from "../types/wallet-router.js";
import {
  isWalletRouterSubaction,
  parseWalletRouterParams,
} from "../types/wallet-router.js";

const LEGACY_SWAP_ACTIONS = new Set([
  "SWAP",
  "SWAP_SOLANA",
  "WALLET_SWAP",
  "TOKEN_SWAP",
]);

const LEGACY_TRANSFER_ACTIONS = new Set([
  "TRANSFER",
  "TRANSFER_TOKEN",
  "WALLET_TRANSFER",
  "SEND_TOKENS",
  "PREPARE_TRANSFER",
]);

const LEGACY_BRIDGE_ACTIONS = new Set(["CROSS_CHAIN_TRANSFER"]);

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

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function legacySubaction(value: unknown): WalletRouterSubaction | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  if (LEGACY_SWAP_ACTIONS.has(upper)) return "swap";
  if (LEGACY_TRANSFER_ACTIONS.has(upper)) {
    return "transfer";
  }
  if (LEGACY_BRIDGE_ACTIONS.has(upper)) return "bridge";
  return undefined;
}

function normalizeRawParams(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const action = raw.action ?? raw.name;
  return {
    subaction:
      raw.subaction ??
      raw.operation ??
      raw.actionType ??
      legacySubaction(action),
    chain: raw.chain ?? raw.fromChain ?? raw.network,
    fromToken:
      raw.fromToken ??
      raw.inputToken ??
      raw.inputTokenCA ??
      raw.inputTokenSymbol ??
      raw.token ??
      raw.tokenAddress,
    toToken:
      raw.toToken ??
      raw.outputToken ??
      raw.outputTokenCA ??
      raw.outputTokenSymbol,
    amount: raw.amount,
    recipient: raw.recipient ?? raw.toAddress ?? raw.to,
    slippageBps: raw.slippageBps ?? raw.slippage,
    mode: raw.mode ?? (raw.confirmed === true ? "execute" : undefined),
    dryRun: raw.dryRun ?? raw.dry_run,
  };
}

function extractRawParams(
  message: Memory,
  state?: State,
  options?: HandlerOptions | Record<string, unknown>,
): Record<string, unknown> | null {
  const optionRecord = objectRecord(options);
  const optionParams = objectRecord(optionRecord?.parameters);
  if (optionParams) return optionParams;

  if (
    optionRecord &&
    ("subaction" in optionRecord || "action" in optionRecord)
  ) {
    return optionRecord;
  }

  const stateRecord = objectRecord(state);
  const stateParams =
    objectRecord(stateRecord?.walletRouterParams) ??
    objectRecord(stateRecord?.walletCanonicalParams);
  if (stateParams) return stateParams;

  return objectRecord(message.content);
}

function toProviderValue(value: unknown): ProviderValue {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toProviderValue(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toProviderValue(item),
      ]),
    );
  }
  return String(value);
}

function toProviderRecord(value: unknown): ProviderDataRecord {
  const converted = toProviderValue(value);
  return converted && typeof converted === "object" && !Array.isArray(converted)
    ? (converted as ProviderDataRecord)
    : { value: converted };
}

function formatFailure(failure: WalletRouterFailure): string {
  if (failure.error === "AMBIGUOUS_CHAIN" && failure.candidates?.length) {
    const chains = failure.candidates
      .map((candidate) => `${candidate.chain} (${candidate.name})`)
      .join(", ");
    return `${failure.detail} Available chains: ${chains}.`;
  }
  if (failure.error === "UNSUPPORTED_CHAIN" && failure.candidates?.length) {
    const chains = failure.candidates
      .map((candidate) => candidate.chain)
      .join(", ");
    return `${failure.detail} Supported chains: ${chains}.`;
  }
  return failure.detail;
}

function resultText(result: WalletRouterResult): string {
  if (!result.ok) {
    return formatFailure(result);
  }
  const execution = result.result;
  if (execution.status === "prepared") {
    const dryRunText = execution.dryRun ? "Dry run prepared" : "Prepared";
    return `${dryRunText} ${execution.subaction} on ${result.handler.chain}.`;
  }
  const id = execution.transactionHash ?? execution.signature;
  return `Submitted ${execution.subaction} on ${result.handler.chain}${id ? `: ${id}` : "."}`;
}

function serviceFromRuntime(
  runtime: IAgentRuntime,
): WalletBackendService | null {
  const service = runtime.getService(WALLET_BACKEND_SERVICE_TYPE);
  if (
    service &&
    typeof (service as WalletBackendService).routeWalletAction === "function"
  ) {
    return service as WalletBackendService;
  }
  return null;
}

async function parseParams(
  message: Memory,
  state?: State,
  options?: HandlerOptions | Record<string, unknown>,
): Promise<WalletRouterParams> {
  const raw = extractRawParams(message, state, options);
  return parseWalletRouterParams(normalizeRawParams(raw ?? {}));
}

export const walletRouterAction: Action = {
  name: "WALLET_ACTION",
  description:
    "Route wallet token operations through the registered chain handlers. Use subaction transfer, swap, or bridge with uniform params: subaction, chain, fromToken, toToken, amount, recipient, slippageBps, mode, dryRun. Omit chain only when one registered handler supports the subaction.",
  descriptionCompressed:
    "Route wallet transfer/swap/bridge via chain registry; params: subaction, chain, fromToken, toToken, amount, recipient, slippageBps, mode, dryRun.",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  similes: [
    "SWAP",
    "SWAP_SOLANA",
    "TRANSFER",
    "TRANSFER_TOKEN",
    "WALLET_SWAP",
    "WALLET_TRANSFER",
    "CROSS_CHAIN_TRANSFER",
    "PREPARE_TRANSFER",
  ],
  parameters: [
    {
      name: "subaction",
      description: "Wallet operation to perform.",
      required: true,
      schema: { type: "string", enum: ["transfer", "swap", "bridge"] },
      examples: ["transfer", "swap", "bridge"],
    },
    {
      name: "chain",
      description:
        "Chain id or name. Omit only when one chain supports subaction.",
      required: false,
      schema: { type: "string" },
      examples: ["base", "solana", "8453"],
    },
    {
      name: "fromToken",
      description: "Source token symbol, native token alias, or token address.",
      required: false,
      schema: { type: "string" },
      examples: ["ETH", "SOL", "USDC"],
    },
    {
      name: "toToken",
      description:
        "Destination token symbol, native token alias, or token address.",
      required: false,
      schema: { type: "string" },
      examples: ["USDC", "SOL"],
    },
    {
      name: "amount",
      description: "Human-readable token amount.",
      required: true,
      schema: { type: "string" },
      examples: ["0.1", "25"],
    },
    {
      name: "recipient",
      description: "Recipient address for transfer.",
      required: false,
      schema: { type: "string" },
      examples: ["0x742d35Cc6634C0532925a3b844Bc454e4438f44e"],
    },
    {
      name: "slippageBps",
      description: "Maximum swap slippage in basis points.",
      required: false,
      schema: { type: "number" },
      examples: [100],
    },
    {
      name: "mode",
      description: "Prepare without submitting, or execute the operation.",
      required: false,
      schema: {
        type: "string",
        enum: ["prepare", "execute"],
        default: "prepare",
      },
      examples: ["prepare", "execute"],
    },
    {
      name: "dryRun",
      description: "Return metadata without signing or sending.",
      required: false,
      schema: { type: "boolean", default: false },
      examples: [true, false],
    },
  ],
  validate: async (_runtime, message, state) => {
    const raw = extractRawParams(message, state);
    if (raw) {
      const normalized = normalizeRawParams(raw);
      if (isWalletRouterSubaction(normalized.subaction)) {
        return true;
      }
    }
    if (selectedContextMatches(state, ["finance", "crypto", "wallet"])) {
      return true;
    }
    const text = message.content?.text;
    if (typeof text !== "string") return false;
    return /\b(wallet|swap|transfer|send|token|crypto|money|balance|solana|evm|ethereum|base|arbitrum)\b/i.test(
      text,
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    let params: WalletRouterParams;
    try {
      params = await parseParams(message, state, options);
    } catch (error) {
      const text = `Invalid wallet parameters: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await callback?.({ text, content: { error: "INVALID_PARAMS" } });
      return {
        success: false,
        text,
        data: { error: "INVALID_PARAMS" },
      };
    }

    const service = serviceFromRuntime(runtime);
    if (!service) {
      const text = "Wallet router service is not available.";
      await callback?.({ text, content: { error: "SERVICE_UNAVAILABLE" } });
      return {
        success: false,
        text,
        data: { error: "SERVICE_UNAVAILABLE" },
      };
    }

    const routed = await service.routeWalletAction(params);
    const text = resultText(routed);
    const data = toProviderRecord(
      routed.ok
        ? {
            ...routed.result,
            handler: routed.handler,
          }
        : {
            error: routed.error,
            detail: routed.detail,
            candidates: routed.candidates,
          },
    );

    await callback?.({
      text,
      content: {
        success: routed.ok,
        ...data,
      },
    });

    return {
      success: routed.ok,
      text,
      values: routed.ok
        ? {
            walletActionSucceeded: routed.result.status === "submitted",
            walletActionPrepared: routed.result.status === "prepared",
            walletChain: routed.handler.chain,
            walletSubaction: routed.result.subaction,
          }
        : {
            walletActionError: routed.error,
          },
      data,
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send 0.2 ETH on Base to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Preparing the Base transfer.",
          action: "WALLET_ACTION",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Swap 1 SOL to USDC on Solana with a dry run first",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Preparing a Solana swap dry run.",
          action: "WALLET_ACTION",
        },
      },
    ],
  ],
};

export default walletRouterAction;
