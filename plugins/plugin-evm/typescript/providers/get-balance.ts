/**
 * @elizaos/plugin-evm Token Balance Provider
 *
 * Provides token balance information for transfer/swap/bridge operations.
 */

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
import { type SupportedChain, EVMError, EVMErrorCode } from "../types";
import { initWalletProvider } from "./wallet";

const tokenBalanceTemplate = `Extract the token ticker and blockchain from the user's message.

User message: "{{userMessage}}"

Return the token symbol and chain name in this format:
<response>
<token>TOKEN_SYMBOL</token>
<chain>CHAIN_NAME</chain>
</response>

If no token is mentioned or it's not a balance inquiry, return:
<response>
<error>Not a token balance request</error>
</response>`;

/**
 * Token balance provider
 */
export const tokenBalanceProvider: Provider = {
  name: "TOKEN_BALANCE",
  description:
    "Token balance for ERC20 tokens when onchain actions are requested",
  dynamic: true,

  get: async (
    runtime: IAgentRuntime,
    message: Memory
  ): Promise<ProviderResult> => {
    const prompt = tokenBalanceTemplate.replace(
      "{{userMessage}}",
      message.content.text ?? ""
    );

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

    // Validate chain is configured
    if (!walletProvider.chains[chain]) {
      throw new EVMError(
        EVMErrorCode.CHAIN_NOT_CONFIGURED,
        `Chain ${chain} is not configured`
      );
    }

    const chainConfig = walletProvider.getChainConfigs(chain as SupportedChain);
    const address = walletProvider.getAddress();

    // Get token info from LiFi
    const tokenData = await getToken(chainConfig.id, token);

    // Get balance
    const publicClient = walletProvider.getPublicClient(
      chain as SupportedChain
    );
    const balanceAbi = parseAbi([
      "function balanceOf(address) view returns (uint256)",
    ]);

    const balance = await publicClient.readContract({
      address: tokenData.address as Address,
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [address],
    });

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
