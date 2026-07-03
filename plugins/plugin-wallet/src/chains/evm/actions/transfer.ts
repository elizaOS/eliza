import {
  composePromptFromState,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { type Hex, parseEther } from "viem";
import { runIntentModel } from "../../../utils/intent-trajectory";
import type { WalletProvider } from "../providers/wallet";
import { transferTemplate } from "../templates";
import {
  EVMError,
  EVMErrorCode,
  parseTransferParams,
  type SupportedChain,
  type Transaction,
  type TransferParams,
} from "../types";
import { buildSendTxParams } from "./helpers";

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
