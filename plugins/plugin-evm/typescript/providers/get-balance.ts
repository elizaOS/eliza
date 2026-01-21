import {
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Provider,
  type ProviderResult,
  parseKeyValueXml,
} from "@elizaos/core";
import { getToken } from "@lifi/sdk";
import { type Address, formatUnits, parseAbi } from "viem";
import { tokenBalanceTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import { EVMError, EVMErrorCode, type SupportedChain } from "../types";
import { initWalletProvider } from "./wallet";

const spec = requireProviderSpec("get-balance");

export const tokenBalanceProvider: Provider = {
  name: spec.name,
  description: "Token balance for ERC20 tokens when onchain actions are requested",
  dynamic: true,

  get: async (runtime: IAgentRuntime, message: Memory): Promise<ProviderResult> => {
    const prompt = tokenBalanceTemplate.replace("{{userMessage}}", message.content.text ?? "");

    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 100,
    });

    const parsed = parseKeyValueXml(response);

    if (!parsed || parsed.error || !parsed.token || !parsed.chain) {
      return { text: "", data: {}, values: {} };
    }

    const token = String(parsed.token).toUpperCase();
    const chain = String(parsed.chain).toLowerCase();

    const walletProvider = await initWalletProvider(runtime);

    if (!walletProvider.chains[chain]) {
      throw new EVMError(EVMErrorCode.CHAIN_NOT_CONFIGURED, `Chain ${chain} is not configured`);
    }

    const chainConfig = walletProvider.getChainConfigs(chain as SupportedChain);
    const address = walletProvider.getAddress();
    const tokenData = await getToken(chainConfig.id, token);
    const publicClient = walletProvider.getPublicClient(chain as SupportedChain);
    const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

    // @ts-expect-error - viem type narrowing issue with readContract parameters
    const balance = (await publicClient.readContract({
      address: tokenData.address as Address,
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;

    const formattedBalance = formatUnits(balance, tokenData.decimals);
    const hasBalance = parseFloat(formattedBalance) > 0;

    return {
      text: `${token} balance on ${chain} for ${address}: ${formattedBalance}`,
      data: {
        token: tokenData.symbol,
        chain,
        balance: formattedBalance,
        decimals: tokenData.decimals,
        address: tokenData.address,
        hasBalance,
      },
      values: {
        token: tokenData.symbol,
        chain,
        balance: formattedBalance,
        hasBalance: String(hasBalance),
      },
    };
  },
};
