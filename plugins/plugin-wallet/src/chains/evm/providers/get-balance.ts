import {
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Provider,
  type ProviderResult,
  parseJSONObjectFromText,
} from "@elizaos/core";
import { getToken } from "@lifi/sdk";
import { type Address, formatUnits, parseAbi } from "viem";
import { runIntentModel } from "../../../utils/intent-trajectory";
import { tokenBalanceTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import { EVMError, EVMErrorCode, type SupportedChain } from "../types";
import { initWalletProvider } from "./wallet";

const spec = requireProviderSpec("get-balance");

export const tokenBalanceProvider: Provider = {
  name: spec.name,
  description: "Token balance for ERC20 tokens when onchain actions are requested",
  descriptionCompressed: "ERC20 token balance for onchain actions.",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory): Promise<ProviderResult> => {
    const inputText =
      typeof message.content === "string"
        ? message.content
        : typeof message.content?.text === "string"
          ? message.content.text
          : "";
    const normalizedText = inputText.toLowerCase();
    const keywordMatch =
      normalizedText.includes("balance") ||
      normalizedText.includes("token") ||
      normalizedText.includes("erc20") ||
      normalizedText.includes("wallet");
    const regexMatch = /\b(?:balance|token|erc20|wallet|chain)\b/i.test(inputText);
    if (!keywordMatch || !regexMatch) {
      return { text: "", data: {}, values: {} };
    }

    try {
      const prompt = tokenBalanceTemplate.replace("{{userMessage}}", inputText);

      const response = await runIntentModel({
        runtime,
        taskName: "evm.token-balance.intent",
        purpose: "provider",
        template: prompt,
        modelType: ModelType.TEXT_SMALL,
        maxTokens: 100,
      });

      const parsed = parseJSONObjectFromText(response) as Record<string, unknown> | null;

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

      const balance = BigInt(
        await publicClient.readContract({
          address: tokenData.address as Address,
          abi: balanceAbi,
          functionName: "balanceOf",
          args: [address],
          authorizationList: undefined,
        })
      );

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
    } catch (error) {
      return {
        text: `Token balance unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        data: {},
        values: {
          tokenBalanceAvailable: false,
          tokenBalanceError: error instanceof Error ? error.name : "TokenBalanceProviderError",
        },
      };
    }
  },
};
