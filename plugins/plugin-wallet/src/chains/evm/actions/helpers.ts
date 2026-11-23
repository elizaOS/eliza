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
  isHash,
  keccak256,
  type SendTransactionParameters,
  type WalletClient,
} from "viem";
import type { Account } from "viem/accounts";
import { sendTransaction } from "viem/actions";

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

export interface EvmSendOutcome {
  readonly hash: Hash;
  /** The RPC did not confirm that it accepted the transaction. */
  readonly sendUncertain: boolean;
}

/**
 * Signs locally, then sends the raw transaction. The hash of the signed bytes
 * is known before the send. An RPC error can come from a gateway or a fallback
 * after an upstream node accepted the same signed bytes. Return the local
 * hash as uncertain unless the provider acknowledges those bytes. Errors
 * before the send still throw.
 */
export async function sendEvmTransaction(
  walletClient: WalletClient,
  params: SendTransactionParameters
): Promise<EvmSendOutcome> {
  let sendUncertain = false;
  const client: WalletClient = {
    ...walletClient,
    async sendRawTransaction(request) {
      const hash = keccak256(request.serializedTransaction);
      let failure = "RPC did not acknowledge the signed transaction hash";
      try {
        const acknowledged = await walletClient.sendRawTransaction(request);
        if (
          typeof acknowledged === "string" &&
          isHash(acknowledged) &&
          acknowledged.toLowerCase() === hash
        ) {
          return hash;
        }
      } catch (error) {
        failure = error instanceof BaseError ? error.shortMessage : "Unknown RPC error";
      }
      // error-policy:J2 the signed transaction may be on the node; its outcome is unknown.
      sendUncertain = true;
      logger.warn({ hash, error: failure }, "[plugin-wallet] EVM send outcome unconfirmed");
      return hash;
    },
  };
  const hash = await sendTransaction(client, params);
  return { hash, sendUncertain };
}
