import { type IAgentRuntime, ModelType, logger, parseJSONObjectFromText } from '@elizaos/core';
import type { Sentiment } from '../schemas';
import type { IToken } from '../types';

const DEGEN_WALLET = 'BzsJQeZ7cvk3pTHmKeuvdhNDkDxcZ6uCXxW2rjwC7RTq';
const _rolePrompt = 'You are a buy signal analyzer.';
/**
 * Template for generating a crypto buy signal based on sentiment analysis and trending tokens.
 *
 * Sentiment analysis:
 * {{sentiment}}
 *
 * Trending tokens:
 * {{trending_tokens}}
 *
 * Only return the following JSON:
 * {
 *     recommended_buy: "the symbol of the token for example DEGENAI",
 *     recommend_buy_address: "the address of the token to purchase, for example: 2sCUCJdVkmyXp4dT8sFaA9LKgSMK4yDPi9zLHiwXpump",
 *     reason: "the reason why you think this is a good buy, and why you chose the specific amount",
 *     buy_amount: "number, for example: 0.1"
 * }
 */
const _template = `

I want you to give a crypto buy signal based on both the sentiment analysis as well as the trending tokens.
Only choose a token that occurs in both the Trending Tokens list as well as the Sentiment analysis. This ensures we have the proper token address.
The sentiment score has a range of -100 to 100, with -100 indicating extreme negativity and 100 indicating extreme positiveness.
My current balance is {{solana_balance}} SOL, also let me know what a good amount would be to buy. Buy amount should at least be 0.05 SOL and maximum 0.25 SOL.

Sentiment analysis:

{{sentiment}}

Trending tokens:

{{trending_tokens}}

Only return the following JSON:

{
recommended_buy: "the symbol of the token for example DEGENAI",
recommend_buy_address: "the address of the token to purchase, for example: 2sCUCJdVkmyXp4dT8sFaA9LKgSMK4yDPi9zLHiwXpump",
reason: "the reason why you think this is a good buy, and why you chose the specific amount",
buy_amount: "number, for example: 0.1"
}`;

/**
 * Interface representing the output of a buy signal.
 * @typedef {object} IBuySignalOutput
 * @property {string} recommended_buy - The recommended buy action.
 * @property {string} recommend_buy_address - The recommended buy address.
 * @property {number} marketcap - The marketcap value.
 * @property {string} reason - The reason for the buy recommendation.
 * @property {string} buy_amount - The amount to buy.
 */
interface IBuySignalOutput {
  recommended_buy: string;
  recommend_buy_address: string;
  marketcap: number;
  reason: string;
  buy_amount: string;
}

export default class BuySignal {
  apiKey: string;
  runtime: IAgentRuntime;
  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async generateSignal(): Promise<boolean> {
    logger.info('buy-signal::generateSignal - Updating latest buy signal');
    // Get all sentiments (TwitterParser fillTimeframe)
    const sentimentsData = (await this.runtime.getCache<Sentiment[]>('sentiments')) || [];
    console.log('sentimentsData', sentimentsData);
    let sentiments = '';

    let idx = 1;
    for (const sentiment of sentimentsData) {
      if (!sentiment?.occuringTokens?.length) continue;
      sentiments += `ENTRY ${idx}\nTIME: ${sentiment.timeslot}\nTOKEN ANALYSIS:\n`;
      for (const token of sentiment.occuringTokens) {
        sentiments += `${token.token} - Sentiment: ${token.sentiment}\n${token.reason}\n`;
      }

      sentiments += '\n-------------------\n';
      idx++;
    }
    const prompt = _template.replace('{{sentiment}}', sentiments);

    // Get all trending tokens
    const trendingData = (await this.runtime.getCache<IToken[]>('tokens_solana')) || [];
    if (!trendingData.length) {
      logger.warn('No trending tokens found in cache');
      return false;
    }
    let tokens = '';
    let index = 1;
    for (const token of trendingData) {
      tokens += `ENTRY ${index}\n\nTOKEN SYMBOL: ${token.name}\nTOKEN ADDRESS: ${token.address}\nPRICE: ${token.price}\n24H CHANGE: ${token.price24hChangePercent}\nLIQUIDITY: ${token.liquidity}`;
      tokens += '\n-------------------\n';
      index++;
    }

    const solanaBalance = await this.getBalance();

    const finalPrompt = prompt
      .replace('{{trending_tokens}}', tokens)
      .replace('{{solana_balance}}', String(solanaBalance));

    //console.log('rolePrompt', rolePrompt)
    //console.log('context', finalPrompt)

    let responseContent: IBuySignalOutput | null = null;
    // Retry if missing required fields
    let retries = 0;
    const maxRetries = 3;
    // recommended_buy, recommend_buy_address, reason, buy_amount
    while (
      retries < maxRetries &&
      (!responseContent?.recommended_buy ||
        !responseContent?.reason ||
        !responseContent?.recommend_buy_address)
    ) {
      // could use OBJECT_LARGE but this expects a string return type rn
      // not sure where OBJECT_LARGE does it's parsing...
      const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        context: finalPrompt,
        system: _rolePrompt,
        temperature: 0.2,
        maxTokens: 4096,
        object: true,
      });

      console.log('intel:buy-signal - response', response);
      responseContent = parseJSONObjectFromText(response) as IBuySignalOutput;

      retries++;
      if (
        !responseContent?.recommended_buy &&
        !responseContent?.reason &&
        !responseContent?.recommend_buy_address
      ) {
        logger.warn('*** Missing required fields, retrying... generateSignal ***');
      }
    }

    if (!responseContent?.recommend_buy_address) {
      console.warn('buy-signal::generateSignal - no buy recommendation');
      return false;
    }

    if (!responseContent?.recommend_buy_address?.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      logger.error('Invalid Solana token address', {
        address: responseContent?.recommend_buy_address,
      });
      return false;
    }

    // Fetch the recommended buys current marketcap
    const apiKey = this.runtime.getSetting('BIRDEYE_API_KEY');
    if (!apiKey) {
      logger.error('BIRDEYE_API_KEY not found in runtime settings');
      return false;
    }

    const BIRDEYE_API = 'https://public-api.birdeye.so';
    const endpoint = `${BIRDEYE_API}/defi/token_overview`;
    const url = `${endpoint}?address=${responseContent.recommend_buy_address}`;

    logger.debug('Making Birdeye API request', {
      url,
      address: responseContent.recommend_buy_address,
    });

    const options = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-chain': 'solana',
        'X-API-KEY': apiKey,
      },
    };

    // Add more detailed error logging
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const errorText = await res.text();
        logger.error('Birdeye API request failed', {
          status: res.status,
          statusText: res.statusText,
          error: errorText,
          address: responseContent.recommend_buy_address,
        });
        throw new Error(`Birdeye marketcap request failed: ${res.status} ${res.statusText}`);
      }

      const resJson = await res.json();
      const marketcap = resJson?.data?.realMc;

      if (!marketcap) {
        logger.warn('No marketcap data returned from Birdeye', {
          response: resJson,
          address: responseContent.recommend_buy_address,
        });
      }

      responseContent.marketcap = Number(marketcap || 0);
    } catch (error) {
      logger.error('Error fetching marketcap data:', error);
      // Continue without marketcap data rather than failing completely
      responseContent.marketcap = 0;
    }

    this.runtime.emitEvent('SPARTAN_TRADE_BUY_SIGNAL', responseContent);

    await this.runtime.setCache<any>('buy_signals', {
      key: 'BUY_SIGNAL',
      data: responseContent,
    });

    return true;
  }

  async getBalance() {
    const url = 'https://zondra-wil7oz-fast-mainnet.helius-rpc.com';
    const headers = {
      'Content-Type': 'application/json',
    };

    const data = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [DEGEN_WALLET],
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
