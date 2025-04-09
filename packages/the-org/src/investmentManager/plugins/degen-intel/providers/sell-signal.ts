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
      logger.info('sell-signal::generateSignal - Updating latest sell signal');

      // First refresh wallet data
      await this.runtime.emitEvent('INTEL_SYNC_WALLET', {});

      // Replace the cache lookup with direct wallet balance check
      const walletBalances = await getWalletBalances(this.runtime);
      const walletData = walletBalances.tokens.map((token) => ({
        mint: token.mint,
        balance: token.uiAmount,
      }));

      const portfolioData = (await this.runtime.getCache<WalletPortfolio>('PORTFOLIO')) || [];
      const txHistoryData =
        (await this.runtime.getCache<WalletPortfolio>('transaction_history')) || [];

      console.log('portfolioData', portfolioData);
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

      // might be best to move this out of this function
      const tradeService = this.runtime.getService(
        ServiceTypes.DEGEN_TRADING
      ) as unknown as ITradeService;
      const tokenData = await tradeService.dataService.getTokensMarketData(tokensHeld);
      prompt = prompt.replace('{{walletData2}}', JSON.stringify(tokenData));

      // here's your wallet should we sell anything
      // FIXME: update prompt

      // Get all sentiments (TwitterParser fillTimeframe)
      const sentimentData = (await this.runtime.getCache<Sentiment[]>('sentiments')) || [];
      //console.log('sentimentsData', sentimentData)
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

      // Get all trending tokens
      /*
      // FIXME: nothing sets this
      const trendingData = await this.runtime.databaseAdapter.getCache<IToken[]>("tokens_solana") || [];
      console.log('trendingData', trendingData)
      let tokens = "";
      let index = 1;
      for (const token of trendingData) {
        tokens += `ENTRY ${index}\n\nTOKEN SYMBOL: ${token.name}\nTOKEN ADDRESS: ${token.address}\nPRICE: ${token.price}\n24H CHANGE: ${token.price24hChangePercent}\nLIQUIDITY: ${token.liquidity}`;
        tokens += "\n-------------------\n";
        index++;
      }
      */

      const solanaBalance = await this.getBalance();

      // prompt.replace("{{trending_tokens}}", tokens).
      const finalPrompt = prompt.replace('{{solana_balance}}', String(solanaBalance));

      //console.log('sell rolePrompt', rolePrompt)
      console.log('sell context', finalPrompt);

      let responseContent: ISellSignalOutput | null = null;
      // Retry if missing required fields
      let retries = 0;
      const maxRetries = 3;
      // recommended_sell, recommend_sell_address, reason, sell_amount
      while (
        retries < maxRetries &&
        (!responseContent?.recommended_sell ||
          !responseContent?.reason ||
          !responseContent?.recommend_sell_address)
      ) {
        // could use OBJECT_LARGE but this expects a string return type rn
        // not sure where OBJECT_LARGE does it's parsing...
        const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
          context: finalPrompt,
          system: rolePrompt,
          temperature: 0.2,
          maxTokens: 4096,
          object: true,
        });

        //console.log('intel:sell-signal - response', response);
        responseContent = parseJSONObjectFromText(response) as ISellSignalOutput;

        retries++;
        if (
          !responseContent?.recommended_sell &&
          !responseContent?.reason &&
          !responseContent?.recommend_sell_address
        ) {
          logger.warn('*** Missing required fields, retrying... shouldRespondPrompt ***');
        }
      }

      //console.log('sell-signal::generateSignal - have response')

      if (!responseContent?.recommend_sell_address) {
        console.warn('sell-signal::generateSignal - no sell recommendation');
        return false;
      }

      //console.log('sell-signal::generateSignal - birdeye time')

      // Fetch the recommended sells current marketcap
      const options = {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-chain': 'solana',
          'X-API-KEY': this.runtime.getSetting('BIRDEYE_API_KEY'),
        },
      };

      const res = await fetch(
        `https://public-api.birdeye.so/defi/token_overview?address=${responseContent.recommend_sell_address}`,
        options
      );
      if (!res.ok) throw new Error('Birdeye marketcap request failed');

      const resJson = await res.json();
      console.log('sell-signal birdeye check', resJson);

      // lots of good info

      const marketcap = resJson?.data?.realMc;

      responseContent.marketcap = Number(marketcap);

      console.log('sell-signal::generateSignal - sending signal');

      /*
      const signal: SellSignalMessage = {
        positionId: uuidv4() as UUID,
        tokenAddress: params.recommend_sell_address,
        // pairId
        amount: params.sell_amount,
        // currentBalance
        // sellRecommenderId
        // walletAddress
        // isSimulation
        // reason
        entityId: "default",
      };
      */

      this.runtime.emitEvent('SPARTAN_TRADE_SELL_SIGNAL', responseContent);

      await this.runtime.setCache<any>('sell_signals', {
        key: 'SELL_SIGNAL',
        data: responseContent,
      });

      return true;
    } catch (e) {
      console.error('sell-signal::generateSignal - err', e);
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
