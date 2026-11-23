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

/**
 * True when the node answered `eth_sendRawTransaction` with a JSON-RPC error
 * that refuses the transaction. Only then is a retry safe. "Already known"
 * and "nonce too low" can mean this same transaction already reached the
 * node (for example through the Eliza Cloud RPC before its public fallback),
 * so they are not a refusal.
 */
function isNodeRejection(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const rpcError = error.walk((cause) => cause instanceof RpcRequestError);
  if (!rpcError) return false;
  return !/already known|known transaction|already imported|nonce too low/i.test(error.message);
}

export interface EvmSendOutcome {
  readonly hash: Hash;
  /** The node did not answer the send, so it may or may not have the transaction. */
  readonly sendUncertain: boolean;
}

/**
 * Signs locally, then sends the raw transaction. The hash of the signed bytes
 * is known before the send, so a send whose answer is lost (RPC timeout, network error, gateway
 * 5xx) is returned as uncertain with that hash instead of thrown: the node may
 * already hold the transaction, and a caller that reports a failure invites a
 * retry that signs the next nonce and pays twice. A JSON-RPC refusal from the
 * node and any error before the send still throw.
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
    if (isNodeRejection(error)) throw error;
    // The node gave no hash, so report the hash of the signed bytes.
    const hash = keccak256(serializedTransaction);
    // error-policy:J2 the signed transaction may be on the node; its outcome is unknown.
    // shortMessage leaves out the RPC URL and request body that viem adds to message.
    logger.warn(
      { hash, error: error instanceof BaseError ? error.shortMessage : String(error) },
      "[plugin-wallet] EVM send got no answer; outcome unconfirmed"
    );
    return { hash, sendUncertain: true };
  }
}
