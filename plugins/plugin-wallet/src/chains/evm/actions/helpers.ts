import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { Address, Chain, Hex, SendTransactionParameters } from "viem";
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
  return typeof privateKey === "string" && privateKey.startsWith("0x");
}

export function isConfirmed(options?: Record<string, unknown>): boolean {
  return options?.confirmed === true;
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
    confirmed: false,
    parameters: {
      ...toConfirmationRecord(params.parameters),
      confirmed: true,
    },
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
