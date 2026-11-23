/**
 * Shared helpers for the EVM wallet actions: the EVM-private-key validator
 * gate, the `confirmationRequired` response shape that stages an on-chain
 * action pending a user confirmation turn, and `buildSendTxParams` for
 * assembling viem `SendTransactionParameters` from optional fields. See
 * `isConfirmed` for why LLM-supplied confirmation flags are never trusted.
 */
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  type Address,
  BaseError,
  type Chain,
  type Hash,
  type Hex,
  keccak256,
  RpcRequestError,
  type SendTransactionParameters,
  type WalletClient,
} from "viem";
import type { Account } from "viem/accounts";

type ActionValidate = NonNullable<Action["validate"]>;

type ConfirmationValue =
  | string
  | number
  | boolean
  | null
  | ConfirmationValue[]
  | { [key: string]: ConfirmationValue };

interface EvmActionValidatorConfig {
  readonly keywords: readonly string[];
  readonly regex: RegExp;
}

export function hasEvmPrivateKey(runtime: IAgentRuntime): boolean {
  const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
  return typeof privateKey === "string" && /^0x/i.test(privateKey);
}

/**
 * LLM-supplied `confirmed` / TOON flags are never trusted (GHSA-rqm7-f4jc-84x3).
 * Use {@link gateWalletFinancialExecution} from `security/wallet-financial-confirmation.ts`.
 */
export function isConfirmed(_options?: Record<string, unknown>): boolean {
  return false;
}

function toConfirmationValue(value: unknown): ConfirmationValue {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toConfirmationValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toConfirmationValue(item)])
    ) as Record<string, ConfirmationValue>;
  }
  return String(value);
}

function toConfirmationRecord(record: object): Record<string, ConfirmationValue> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, toConfirmationValue(value)])
  ) as Record<string, ConfirmationValue>;
}

export async function confirmationRequired(params: {
  actionName: string;
  preview: string;
  parameters: object;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const confirmation = {
    actionName: params.actionName,
    parameters: toConfirmationRecord(params.parameters),
    instructions:
      "Reply yes to confirm or no to cancel. Do not set confirmed:true in action parameters.",
  };

  const content = {
    success: false,
    requiresConfirmation: true,
    preview: params.preview,
    confirmation,
  };

  await params.callback?.({
    text: params.preview,
    content,
  });

  return {
    success: false,
    text: params.preview,
    data: content,
  };
}

export function createEvmActionValidator(_config: EvmActionValidatorConfig): ActionValidate {
  return async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown
  ): Promise<boolean> => {
    try {
      return hasEvmPrivateKey(runtime);
    } catch {
      return false;
    }
  };
}

export function buildSendTxParams(params: {
  account: Account;
  to: Address;
  value?: bigint;
  data?: Hex;
  chain?: Chain;
  gas?: bigint;
  gasPrice?: bigint;
}): SendTransactionParameters {
  const txParams: Partial<SendTransactionParameters> &
    Pick<SendTransactionParameters, "account" | "to"> = {
    account: params.account,
    to: params.to,
  };

  if (params.value !== undefined) {
    txParams.value = params.value;
  }
  if (params.data !== undefined) {
    txParams.data = params.data;
  }
  if (params.chain !== undefined) {
    txParams.chain = params.chain;
  }
  if (params.gas !== undefined) {
    txParams.gas = params.gas;
  }
  if (params.gasPrice !== undefined) {
    txParams.gasPrice = params.gasPrice;
  }

  return txParams as SendTransactionParameters;
}

function rpcSendError(error: unknown): RpcRequestError | undefined {
  const cause = error instanceof BaseError
    ? error.walk((value) => value instanceof RpcRequestError)
    : undefined;
  return cause instanceof RpcRequestError ? cause : undefined;
}

function rejectedSendReason(error: RpcRequestError | undefined): string | undefined {
  if (!error) return undefined;
  const { code, details } = error;
  // JSON-RPC request admission failures precede the send.
  if (code === -32700 || code === -32600 || code === -32601 || code === -32602) {
    return "invalid RPC request";
  }
  if (code !== -32000 && code !== -32003) return undefined;
  // Nodes reuse these codes for duplicates and arbitrary server errors.
  return /^(insufficient funds|intrinsic gas too (?:low|high)|invalid sender|fee cap less than block base fee)\b/i
    .exec(details)?.[1]?.toLowerCase();
}

export interface EvmSendOutcome {
  readonly hash: Hash;
  /** The send has no conclusive answer, so the node may still have the transaction. */
  readonly sendUncertain: boolean;
}

/**
 * Signs locally, then sends the raw transaction. The hash of the signed bytes
 * is known before the send, so a send whose answer is lost (RPC timeout, network error, gateway
 * 5xx) is returned as uncertain with that hash instead of thrown: the node may
 * already hold the transaction. A definite refusal or a failure before the
 * send still throws.
 */
export async function sendEvmTransaction(
  walletClient: WalletClient,
  params: SendTransactionParameters
): Promise<EvmSendOutcome> {
  const request = await walletClient.prepareTransactionRequest(
    params as Parameters<WalletClient["prepareTransactionRequest"]>[0]
  );
  const serializedTransaction = await walletClient.signTransaction(
    request as Parameters<WalletClient["signTransaction"]>[0]
  );
  try {
    const hash = await walletClient.sendRawTransaction({ serializedTransaction });
    return { hash, sendUncertain: false };
  } catch (error) {
    const rpcError = rpcSendError(error);
    const refusal = rejectedSendReason(rpcError);
    if (refusal) throw new Error(`EVM node rejected the transaction: ${refusal}`);
    // error-policy:J2 the signed transaction may be on the node; its outcome is unknown.
    const hash = keccak256(serializedTransaction);
    const rpcCode = rpcError?.code;
    logger.warn(
      { hash, ...(Number.isInteger(rpcCode) ? { rpcCode } : {}) },
      "[plugin-wallet] EVM send outcome unconfirmed"
    );
    return { hash, sendUncertain: true };
  }
}
