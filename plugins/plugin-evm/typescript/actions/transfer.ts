import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import { formatEther, type Hex, parseEther } from "viem";
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

export class TransferAction {
  constructor(private readonly walletProvider: WalletProvider) {}

  async transfer(params: TransferParams): Promise<Transaction> {
    let data: Hex = "0x";
    if (params.data && params.data !== "0x") {
      data = params.data;
    }

    const walletClient = this.walletProvider.getWalletClient(params.fromChain);

    if (!walletClient.account) {
      throw new EVMError(EVMErrorCode.WALLET_NOT_INITIALIZED, "Wallet account is not available");
    }

    // @ts-expect-error - viem type narrowing issue with sendTransaction parameters
    const hash = await walletClient.sendTransaction({
      account: walletClient.account,
      to: params.toAddress,
      value: parseEther(params.amount),
      data,
      chain: walletClient.chain,
    });

    return {
      hash,
      from: walletClient.account.address,
      to: params.toAddress,
      value: parseEther(params.amount),
      data,
    };
  }
}

async function buildTransferDetails(
  state: State,
  message: Memory,
  runtime: IAgentRuntime,
  wp: WalletProvider
): Promise<TransferParams> {
  const chains = wp.getSupportedChains();
  const balances = await wp.getWalletBalances();
  state.chainBalances = Object.entries(balances)
    .map(([chain, balance]) => {
      const chainConfig = wp.getChainConfigs(chain as SupportedChain);
      return `${chain}: ${balance} ${chainConfig.nativeCurrency.symbol}`;
    })
    .join(", ");

  state = await runtime.composeState(message, ["RECENT_MESSAGES"], true);
  state.supportedChains = chains.join(" | ");

  const context = composePromptFromState({
    state,
    template: transferTemplate,
  });

  const xmlResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt: context,
  });

  const parsedXml = parseKeyValueXml(xmlResponse);

  if (!parsedXml) {
    throw new EVMError(
      EVMErrorCode.INVALID_PARAMS,
      "Failed to parse XML response from LLM for transfer details."
    );
  }

  const rawParams = {
    fromChain: String(parsedXml.fromChain ?? "").toLowerCase(),
    toAddress: String(parsedXml.toAddress ?? ""),
    amount: String(parsedXml.amount ?? ""),
    data: parsedXml.data ? String(parsedXml.data) : undefined,
    token: parsedXml.token ? String(parsedXml.token) : undefined,
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

const spec = requireActionSpec("TRANSFER");

export const transferAction: Action = {
  name: spec.name,
  description: spec.description,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    }

    const walletProvider = await initWalletProvider(runtime);
    const action = new TransferAction(walletProvider);
    const paramOptions = await buildTransferDetails(state, message, runtime, walletProvider);

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

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },

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
