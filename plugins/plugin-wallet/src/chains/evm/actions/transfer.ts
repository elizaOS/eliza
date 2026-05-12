import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { formatEther, type Hex, parseEther } from "viem";
import { runIntentModel } from "../../../utils/intent-trajectory";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { initWalletProvider, type WalletProvider } from "../providers/wallet";
import { transferTemplate } from "../templates";
import {
  EVMError,
  EVMErrorCode,
  parseTransferParams,
  type SupportedChain,
  type Transaction,
  type TransferParams,
} from "../types";
import {
  buildSendTxParams,
  confirmationRequired,
  createEvmActionValidator,
  isConfirmed,
} from "./helpers";

export class TransferAction {
  constructor(private readonly walletProvider: WalletProvider) {}

  async transfer(params: TransferParams): Promise<Transaction> {
    let data: Hex = "0x";
    if (params.data && params.data !== "0x") {
      data = params.data;
    }

    const walletClient = this.walletProvider.getWalletClient(params.fromChain);

    const account = walletClient.account;
    if (!account) {
      throw new EVMError(EVMErrorCode.WALLET_NOT_INITIALIZED, "Wallet account is not available");
    }

    const chainConfig = this.walletProvider.getChainConfigs(params.fromChain);
    const hash = await walletClient.sendTransaction(
      buildSendTxParams({
        account,
        to: params.toAddress,
        value: parseEther(params.amount),
        data,
        chain: chainConfig,
      })
    );

    return {
      hash,
      from: account.address,
      to: params.toAddress,
      value: parseEther(params.amount),
      data,
    };
  }
}

export async function buildTransferDetails(
  state: State,
  message: Memory,
  runtime: IAgentRuntime,
  wp: WalletProvider
): Promise<TransferParams> {
  const chains = wp.getSupportedChains();
  const balances = await wp.getWalletBalances();
  state = await runtime.composeState(message, ["RECENT_MESSAGES"], true);

  state.chainBalances = Object.entries(balances)
    .map(([chain, balance]) => {
      const chainConfig = wp.getChainConfigs(chain as SupportedChain);
      return `${chain}: ${balance} ${chainConfig.nativeCurrency.symbol}`;
    })
    .join(", ");
  state.supportedChains = chains.join(" | ");

  const context = composePromptFromState({
    state,
    template: transferTemplate,
  });

  const llmResponse = await runIntentModel({
    runtime,
    taskName: "evm.transfer.intent",
    template: context,
    modelType: ModelType.TEXT_SMALL,
  });

  const parsedResponse = parseJSONObjectFromText(llmResponse) as Record<string, unknown> | null;

  if (!parsedResponse) {
    throw new EVMError(
      EVMErrorCode.INVALID_PARAMS,
      "Failed to parse structured response from LLM for transfer details."
    );
  }

  const rawParams = {
    fromChain: String(parsedResponse.fromChain ?? "").toLowerCase(),
    toAddress: String(parsedResponse.toAddress ?? ""),
    amount: String(parsedResponse.amount ?? ""),
    data: parsedResponse.data ? String(parsedResponse.data) : undefined,
    token: parsedResponse.token ? String(parsedResponse.token) : undefined,
  };

  const transferDetails = parseTransferParams(rawParams);
  const existingChain = wp.chains[transferDetails.fromChain];
  if (!existingChain) {
    throw new EVMError(
      EVMErrorCode.CHAIN_NOT_CONFIGURED,
      `Chain "${transferDetails.fromChain}" not configured. Available chains: ${chains.toString()}`
    );
  }

  return transferDetails;
}

const legacySpec = requireActionSpec("EVM_TRANSFER");
const spec = { ...legacySpec, name: "WALLET" };

export const transferAction: Action = {
  name: spec.name,
  description: spec.description,
  descriptionCompressed: spec.descriptionCompressed,
  contexts: ["finance", "crypto", "wallet", "payments"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "payments"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "amount",
      description: "Human-readable amount to transfer.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "toAddress",
      description: "Recipient EVM address.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "fromChain",
      description: "Source EVM chain.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "token",
      description: "Native token or ERC-20 token symbol/address.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Set true after preview confirmation to submit.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    }

    const walletProvider = await initWalletProvider(runtime);
    const paramOptions = await buildTransferDetails(state, message, runtime, walletProvider);

    if (!isConfirmed(options)) {
      const tokenLabel = paramOptions.token?.trim() || "native token";
      const preview = `Review EVM transfer before submitting: ${paramOptions.amount} ${tokenLabel} on ${paramOptions.fromChain} to ${paramOptions.toAddress}. Re-invoke ${spec.name} with confirmed: true to submit.`;
      return confirmationRequired({
        actionName: spec.name,
        preview,
        parameters: paramOptions,
        callback,
      });
    }

    const action = new TransferAction(walletProvider);
    const transferResp = await action.transfer(paramOptions);

    const successText = `Successfully transferred ${paramOptions.amount} tokens to ${paramOptions.toAddress}\nTransaction Hash: ${transferResp.hash}`;

    if (callback) {
      callback({
        text: successText,
        content: {
          success: true,
          hash: transferResp.hash,
          amount: formatEther(transferResp.value),
          recipient: transferResp.to,
          chain: paramOptions.fromChain,
        },
      });
    }

    return {
      success: true,
      text: successText,
      values: {
        transferSucceeded: true,
      },
      data: {
        actionName: "EVM_TRANSFER_TOKENS",
        transactionHash: transferResp.hash,
        chain: paramOptions.fromChain,
        amount: paramOptions.amount,
        recipient: transferResp.to,
      },
    };
  },
  validate: createEvmActionValidator({
    keywords: ["transfer"],
    regex: /\b(?:transfer)\b/i,
  }),

  examples: [
    [
      {
        name: "assistant",
        content: {
          text: "I'll help you transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          action: "SEND_TOKENS",
        },
      },
      {
        name: "user",
        content: {
          text: "Transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          action: "SEND_TOKENS",
        },
      },
    ],
  ],

  similes: spec.similes ? [...spec.similes] : [],
};
