import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  type TemplateType,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { ethers, Wallet, JsonRpcProvider, Contract } from 'ethers';
import { getAliAgentKeyMarketDataTemplate } from '../templates/market-data';
import { KEYS_FACTORY_ADDRESS, INFT_KEYS_FACTORY_ADDRESS } from '../constants';
import { KEYS_FACTORY_ABI, TRADEABLE_SHARES_ABI, ALI_TOKEN_ERC20_ABI } from '../abis';

interface MarketDataParams {
  agentId: string;
  network: 'base' | 'ethereum';
}

export const getAliAgentKeyMarketDataAction: Action = {
  name: 'ALETHEA_GET_MARKET_DATA',
  similes: ['FETCH_KEY_PRICES', 'GET_KEY_MARKET_INFO'].map((s) => `ALETHEA_${s}`),
  description: 'Retrieve market data for ALI Agent Keys.',

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    logger.info('[getAliAgentKeyMarketDataAction] Validate called.');
    if (!runtime.getSetting('ALETHEA_RPC_URL')) {
      logger.error('[getAliAgentKeyMarketDataAction] ALETHEA_RPC_URL is required.');
      return false;
    }
    logger.info('[getAliAgentKeyMarketDataAction] Basic validation passed.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getAliAgentKeyMarketDataAction] Handler called.');
    let params: MarketDataParams | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: getAliAgentKeyMarketDataTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsedParams = parseJSONObjectFromText(modelResponse) as
        | MarketDataParams
        | { error: string };

      if ('error' in parsedParams) throw new Error(`Model error: ${parsedParams.error}`);
      params = parsedParams;
      const { agentId, network } = params;

      if (!agentId || !network) throw new Error('Agent ID and network are required.');

      const [tokenAddress, tokenId] = agentId.split(':');
      if (!ethers.isAddress(tokenAddress) || !tokenId) {
        throw new Error("Invalid Agent ID format. Expected 'tokenAddress:tokenId'.");
      }

      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL') as string;
      const provider = new JsonRpcProvider(rpcUrl);

      const factoryAddress = network === 'base' ? KEYS_FACTORY_ADDRESS : INFT_KEYS_FACTORY_ADDRESS;
      const factoryContract = new Contract(factoryAddress, KEYS_FACTORY_ABI, provider);

      const sharesSubject = { tokenAddress, tokenId };
      const marketContractAddress = await factoryContract.lookupSharesContract(sharesSubject);

      if (marketContractAddress === ethers.ZeroAddress) {
        throw new Error(`No key market found for Agent ID: ${agentId}`);
      }

      const marketContract = new Contract(marketContractAddress, TRADEABLE_SHARES_ABI, provider);
      const price_BigNumber = await marketContract.getBuyPrice(ethers.parseEther('1'));

      let liquidity_BigNumber: bigint;
      if (network === 'ethereum') {
        liquidity_BigNumber = await provider.getBalance(marketContractAddress);
      } else {
        const collateralTokenAddress = await marketContract.collateralToken();
        const collateralTokenContract = new Contract(
          collateralTokenAddress,
          ALI_TOKEN_ERC20_ABI,
          provider
        );
        liquidity_BigNumber = await collateralTokenContract.balanceOf(marketContractAddress);
      }

      const marketData = {
        currentPrice: ethers.formatEther(price_BigNumber),
        volume24h: '0', // Placeholder as per guide
        liquidity: ethers.formatEther(liquidity_BigNumber),
      };

      const responseText =
        `📊 **ALI Agent Key Market Data**\n\n` +
        `**Agent ID:** ${agentId}\n` +
        `**Network:** ${network}\n` +
        `**Current Price (for 1 Key):** ${marketData.currentPrice} Tokens\n` +
        `**Liquidity:** ${marketData.liquidity} Tokens\n` +
        `**24h Volume:** ${marketData.volume24h} (Not available on-chain)`;

      const responseContent: Content = { text: responseText, data: marketData };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getAliAgentKeyMarketDataAction] Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching market data**: ${errorMessage}`,
        data: { error: errorMessage, ...params },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: "Get market data for agent '0xabc...:123' on base via Alethea." },
      },
      {
        name: '{{user2}}',
        content: {
          text: "Fetching market data for agent '0xabc...:123' via Alethea...",
          actions: ['ALETHEA_GET_MARKET_DATA'],
        },
      },
    ],
  ],
};
