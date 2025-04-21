import { parseJSONObjectFromText, type IAgentRuntime, logger, ModelType } from '@elizaos/core';
import type { Sentiment } from '../schemas';
import type { IToken } from '../types';

import { ServiceTypes } from '../../degen-trader/types';
import { getWalletBalances } from '../../degen-trader/utils/wallet';
import type { ITradeService } from '../../degen-trader/types';
import type { WalletPortfolio } from '../../degen-trader/types/trading';

const rolePrompt = 'You are a sell signal analyzer.';
const template = `

I want you to give a crypto sell signal based on both the sentiment analysis as well as the wallet token data.
The sentiment score has a range of -100 to 100, with -100 indicating extreme negativity and 100 indicating extreme positiveness.
My current balance is {{solana_balance}} SOL, If I have less than 0.3 SOL, I should up the priority on selling something but we don't need to realize a heavy loss over it.

Sentiment analysis:

{{sentiment}}

Wallet tokens:

{{walletData}}

Additional wallet token data (in JSON format):
{{walletData2}}

Only return the following JSON:

{
  recommended_sell: "the symbol of the token for example DEGENAI",
  recommend_sell_address: "the address of the token to purchase, for example: 2sCUCJdVkmyXp4dT8sFaA9LKgSMK4yDPi9zLHiwXpump",
  reason: "the reason why you think this is a good sell, and why you chose the specific amount",
  sell_amount: "number, for example: 600.54411 (number amount of tokens to sell)"
}`;

interface ISellSignalOutput {
  recommended_sell: string;
  recommend_sell_address: string;
  marketcap?: number;
  reason: string;
  sell_amount: string;
}

export default class SellSignal {
  apiKey: string;
  runtime: IAgentRuntime;
  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async generateSignal(): Promise<boolean> {
    try {
      logger.info('sell-signal::generateSignal - Generating sell signal');

      // First refresh wallet data
      await this.runtime.emitEvent('INTEL_SYNC_WALLET', {});

      // Replace the cache lookup with direct wallet balance check
      const walletBalances = await getWalletBalances(this.runtime);
      const walletData = walletBalances.tokens.map((token) => ({
        mint: token.mint,
        balance: token.uiAmount,
      }));

      if (!walletData.length) {
        logger.warn('No wallet tokens found');
        return false;
      }

      const portfolioData = (await this.runtime.getCache<WalletPortfolio>('PORTFOLIO')) || [];
      const txHistoryData =
        (await this.runtime.getCache<WalletPortfolio>('transaction_history')) || [];

      // collect CA
      let walletProviderStr = 'Your wallet contents: ';
      const tokensHeld = [];
      for (const t of walletData) {
        walletProviderStr +=
          'You hold ' +
          t.balance +
          '(' +
          t.balance +
          ') of ' +
          t.mint +
          ' (' +
          t.mint +
          ' CA: ' +
          t.mint +
          ') worth $' +
          t.balance +
          'usd (' +
          t.balance +
          ' sol)' +
          '\n';
        tokensHeld.push(t.mint);
      }
      let prompt = template.replace('{{walletData}}', walletProviderStr);

      // Get token market data
      // FIXME: can we just get from the cache or the local birdeye functions?
      const tradeService = this.runtime.getService(
        ServiceTypes.DEGEN_TRADING
      ) as unknown as ITradeService;
      if (tradeService) {
        const tokenData = await tradeService.dataService.getTokensMarketData(tokensHeld);
        prompt = prompt.replace('{{walletData2}}', JSON.stringify(tokenData));
      } else {
        prompt = prompt.replace('{{walletData2}}', '');
      }

      // Get all sentiments
      const sentimentData = (await this.runtime.getCache<Sentiment[]>('sentiments')) || [];
      if (!sentimentData.length) {
        logger.warn('No sentiment data found');
        return false;
      }

      let sentiments = '';
      let idx = 1;
      for (const sentiment of sentimentData) {
        if (!sentiment?.occuringTokens?.length) continue;
        sentiments += `ENTRY ${idx}\nTIME: ${sentiment.timeslot}\nTOKEN ANALYSIS:\n`;
        for (const token of sentiment.occuringTokens) {
          sentiments += `${token.token} - Sentiment: ${token.sentiment}\n${token.reason}\n`;
        }
        sentiments += '\n-------------------\n';
        idx++;
      }
      prompt = prompt.replace('{{sentiment}}', sentiments);

      const solanaBalance = await this.getBalance();
      const finalPrompt = prompt.replace('{{solana_balance}}', String(solanaBalance));

      // Get sell recommendation from model
      let responseContent: ISellSignalOutput | null = null;
      let retries = 0;
      const maxRetries = 3;

      while (
        retries < maxRetries &&
        (!responseContent?.recommended_sell ||
          !responseContent?.reason ||
          !responseContent?.recommend_sell_address)
      ) {
        const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: finalPrompt,
          system: rolePrompt,
          temperature: 0.2,
          maxTokens: 4096,
          object: true,
        });

        responseContent = parseJSONObjectFromText(response) as ISellSignalOutput;
        retries++;

        if (
          !responseContent?.recommended_sell &&
          !responseContent?.reason &&
          !responseContent?.recommend_sell_address
        ) {
          logger.warn('*** Missing required fields, retrying... generateSignal ***');
        }
      }

      if (!responseContent?.recommend_sell_address) {
        logger.warn('sell-signal::generateSignal - no sell recommendation');
        return false;
      }

      // Validate token address format
      if (!responseContent?.recommend_sell_address?.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
        logger.error('Invalid Solana token address', {
          address: responseContent?.recommend_sell_address,
        });
        return false;
      }

      // Fetch marketcap data
      const apiKey = this.runtime.getSetting('BIRDEYE_API_KEY');
      if (!apiKey) {
        logger.error('BIRDEYE_API_KEY not found in runtime settings');
        return false;
      }

      const BIRDEYE_API = 'https://public-api.birdeye.so';
      const endpoint = `${BIRDEYE_API}/defi/token_overview`;
      const url = `${endpoint}?address=${responseContent.recommend_sell_address}`;

      logger.debug('Making Birdeye API request', {
        url,
        address: responseContent.recommend_sell_address,
      });

      const options = {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-chain': 'solana',
          'X-API-KEY': apiKey,
        },
      };

      try {
        const res = await fetch(url, options);
        if (!res.ok) {
          const errorText = await res.text();
          logger.error('Birdeye API request failed', {
            status: res.status,
            statusText: res.statusText,
            error: errorText,
            address: responseContent.recommend_sell_address,
          });
          throw new Error(`Birdeye marketcap request failed: ${res.status} ${res.statusText}`);
        }

        const resJson = await res.json();
        const marketcap = resJson?.data?.realMc;

        if (!marketcap) {
          logger.warn('No marketcap data returned from Birdeye', {
            response: resJson,
            address: responseContent.recommend_sell_address,
          });
        }

        responseContent.marketcap = Number(marketcap || 0);
      } catch (error) {
        logger.error('Error fetching marketcap data:', error);
        // Continue without marketcap data rather than failing completely
        responseContent.marketcap = 0;
      }

      // Add logging before emitting
      logger.info('Emitting sell signal', {
        token: responseContent.recommended_sell,
        address: responseContent.recommend_sell_address,
        amount: responseContent.sell_amount,
      });

      // Emit sell signal event
      await this.runtime.emitEvent('SPARTAN_TRADE_SELL_SIGNAL', {
        recommend_sell_address: responseContent.recommend_sell_address,
        sell_amount: responseContent.sell_amount,
        reason: responseContent.reason,
      });

      logger.info('Sell signal emitted successfully');

      // Cache the signal
      await this.runtime.setCache<any>('sell_signals', {
        key: 'SELL_SIGNAL',
        data: responseContent,
      });

      return true;
    } catch (error) {
      logger.error('Error generating sell signal:', error);
      return false;
    }
  }

  async getBalance() {
    // this.runtime.getSetting("BIRDEYE_API_KEY")
    const url = 'https://zondra-wil7oz-fast-mainnet.helius-rpc.com';
    const headers = {
      'Content-Type': 'application/json',
    };

    const data = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [this.runtime.getSetting('SOLANA_PUBLIC_KEY')],
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(data),
    });

    const result = await response.json();

    const lamportsBalance = result?.result?.value;

    return lamportsBalance / 1000000000;
  }
}
