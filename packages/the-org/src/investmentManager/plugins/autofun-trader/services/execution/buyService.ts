import {
  type IAgentRuntime,
  ModelType,
  logger,
  type UUID,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { BaseTradeService } from '../base/BaseTradeService';
import { TokenValidationService } from '../validation/TokenValidationService';
import { TradeCalculationService } from '../calculation/tradeCalculation';
import { BuySignalMessage } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { TradeMemoryService } from '../tradeMemoryService';
import { WalletService } from '../walletService';
import { DataService } from '../dataService';
import { AnalyticsService } from '../analyticsService';

// Only choose a token that occurs in both the Trending Tokens list as well as the Sentiment analysis. This ensures we have the proper token address.
// The sentiment score has a range of -100 to 100, with -100 indicating extreme negativity and 100 indicating extreme positiveness.

const buyTemplate = `
I want you to give a crypto buy signal based on both the sentiment analysis as well as the trending tokens.
My current balance is {{solana_balance}} SOL, If I have less than 0.3 SOL then I should not buy unless it's really good opportunity.
Also let me know what a good amount would be to buy. Buy amount should at least be 0.05 SOL and maximum 0.25 SOL.

Sentiment analysis:

{{sentiment}}

Tokens:

{{tokens}}

Only return the following JSON:

{
recommended_buy: "the symbol of the token for example DEGENAI",
recommend_buy_address: "the address of the token to purchase, for example: 2sCUCJdVkmyXp4dT8sFaA9LKgSMK4yDPi9zLHiwXpump",
reason: "the reason why you think this is a good buy, and why you chose the specific amount",
buy_amount: "number, for example: 0.1"
}`;

export class BuyService extends BaseTradeService {
  private validationService: TokenValidationService;
  private calculationService: TradeCalculationService;
  private tradeMemoryService: TradeMemoryService;

  constructor(
    runtime: IAgentRuntime,
    walletService: WalletService,
    dataService: DataService,
    analyticsService: AnalyticsService,
    tradeMemoryService: TradeMemoryService
  ) {
    super(runtime, walletService, dataService, analyticsService);
    this.validationService = new TokenValidationService(
      runtime,
      walletService,
      dataService,
      analyticsService
    );
    this.calculationService = new TradeCalculationService(
      runtime,
      walletService,
      dataService,
      analyticsService
    );
    this.tradeMemoryService = tradeMemoryService;
  }

  async initialize(): Promise<void> {
    logger.info('Initializing buy service');
    this.runtime.registerEvent('SPARTAN_TRADE_BUY_SIGNAL', this.handleBuySignal.bind(this));
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }

  async generateSignal() {
    console.log('buy-signal - start');
    // get data from plugin-auto
    //const tradeService = runtime.getService(ServiceTypes.AUTOFUN_TRADING)
    // or make call ourself
    const url =
      'https://api.auto.fun/api/tokens?limit=200&page=1&sortBy=createdAt&sortOrder=desc&hideImported=1';
    const res = await fetch(url);
    const data = await res.json();

    /*
  page: 1,
  totalPages: 7,
  total: 1207,
  hasMore: true,
*/

    console.log('buy-signal - got token data', data.tokens.length);
    if (!data.tokens?.length) {
      logger.warn('buy-signal - no autofun response');
      return false;
    }

    // inject into prompt
    let prompt = buyTemplate;
    prompt = prompt.replace('{{sentiment}}', 'The highly technical analysis is: buy whatever dude');

    let latestTxt =
      '\nCurrent Auto.fun list of all active cryptocurrencies with latest market data:\n';
    let idx = 1;
    const fields = [
      'id',
      'name',
      'ticker',
      'url',
      'twitter',
      'telegram',
      'discord',
      'farcaster',
      'description',
      'liquidity',
      'currentPrice',
      'tokenSupplyUiAmount',
      'holderCount',
      'volume24h',
      'price24hAgo',
      'priceChange24h',
      'curveProgress',
    ];
    const remaps = {
      ticker: 'symbol',
    };
    latestTxt +=
      'id, name, symbol, url, twitter, telegram, discord, farcaster, description, liquidity, currentPrice, tokenSupplyUiAmount, holderCount, volume24h, price24hAgo, priceChange24h, curveProgress';
    for (const t of data.tokens) {
      const out = [];
      for (const f of fields) {
        out.push(t[f]);
      }
      latestTxt += out.join(', ') + '\n';
    }

    prompt = prompt.replace('{{tokens}}', latestTxt);

    // get balance from plugin-solana
    const walletBalance = await this.walletService.getBalance();
    prompt = prompt.replace('{{solana_balance}}', walletBalance);

    console.log('buy-signal - calling llm');

    // run llm call
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
        prompt,
        system: 'You are a buy signal analyzer.',
        temperature: 0.2,
        maxTokens: 4096,
        object: true,
      });

      console.log('afTrader:buy-signal - response', response);
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
      console.warn('afTrader:buy-signal::generateSignal - no buy recommendation');
      return false;
    }

    if (!responseContent?.recommend_buy_address?.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      logger.error('Invalid Solana token address', {
        address: responseContent?.recommend_buy_address,
      });
      return false;
    }
    console.log('maybe we should we execute or something');
    //const walletBalance = await this.walletService.getBalance();

    const params = responseContent;
    console.log('params', params);
    const signal: BuySignalMessage = {
      positionId: uuidv4() as UUID,
      tokenAddress: params.recommend_buy_address,
      entityId: 'default',
      tradeAmount: params.buy_amount,
      expectedOutAmount: '0',
    };
    console.log('signal', signal);

    await this.updateExpectedOutAmount(signal);

    const buyAmount = await this.calculationService.calculateOptimalBuyAmount({
      tokenAddress: signal.tokenAddress,
      walletBalance,
      signal,
    });

    if (buyAmount <= 0) {
      return { success: false, error: 'Buy amount too small' };
    }

    const slippageBps = await this.calculationService.calculateDynamicSlippage(
      signal.tokenAddress,
      buyAmount,
      false
    );

    const wallet = await this.walletService.getWallet();
    const result = await wallet.buy({
      tokenAddress: signal.tokenAddress,
      amountInSol: buyAmount,
      slippageBps,
    });

    if (result.success) {
      await this.tradeMemoryService.createTrade({
        tokenAddress: signal.tokenAddress,
        chain: 'solana',
        type: 'BUY',
        amount: buyAmount.toString(),
        price: marketData.priceUsd.toString(),
        txHash: result.signature,
        metadata: {
          slippage: slippageBps,
          expectedAmount: signal.expectedOutAmount,
          receivedAmount: result.outAmount,
          valueUsd: result.swapUsdValue,
        },
      });

      if (result.outAmount) {
        await this.analyticsService.trackSlippageImpact(
          signal.tokenAddress,
          signal.expectedOutAmount || '0',
          result.outAmount,
          slippageBps,
          false
        );
      }
    }
  }

  private async handleBuySignal(params: any): Promise<void> {
    const TRADER_BUY_KUMA = this.runtime.getSetting('TRADER_BUY_KUMA');
    if (TRADER_BUY_KUMA) {
      fetch(TRADER_BUY_KUMA).catch((e) => {
        logger.error('TRADER_BUY_KUMA err', e);
      });
    }

    const signal: BuySignalMessage = {
      positionId: uuidv4() as UUID,
      tokenAddress: params.recommend_buy_address,
      entityId: 'default',
      tradeAmount: params.buy_amount,
      expectedOutAmount: '0',
    };

    await this.updateExpectedOutAmount(signal);
    this.executeBuy(signal).then((result) => {
      logger.info('executeBuy - result', result);
    });
  }

  private async updateExpectedOutAmount(signal: BuySignalMessage): Promise<void> {
    if (!signal.tradeAmount) return;

    try {
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${
          signal.tokenAddress
        }&amount=${Math.round(Number(signal.tradeAmount) * 1e9)}&slippageBps=0`
      );

      if (quoteResponse.ok) {
        const quoteData = await quoteResponse.json();
        signal.expectedOutAmount = quoteData.outAmount;
      }
    } catch (error) {
      logger.warn('Failed to get expected out amount for buy', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
