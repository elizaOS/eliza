import type { IAgentRuntime } from '@elizaos/core';

import { acquireService, askLlmObject } from '../utils';

// FIXME two outputs depending on balance

const buyTemplate = `
I want you to give a crypto buy signal based on both the sentiment analysis as well as the trending tokens.
Only choose a token that occurs in both the Trending Tokens list as well as the Sentiment analysis. This ensures we have the proper token address.
The sentiment score has a range of -100 to 100, with -100 indicating extreme negativity and 100 indicating extreme positiveness.
My current balance is {{solana_balance}} SOL, If I have less than 0.3 SOL then I should not buy unless it's really good opportunity.
Also let me know what a good amount would be to buy. Buy amount should at least be 0.05 SOL and maximum 0.25 SOL.

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

export async function llmStrategy(runtime: IAgentRuntime) {
  const service = await acquireService(runtime, 'TRADER_STRATEGY', 'llm trading strategy');
  const infoService = await acquireService(runtime, 'TRADER_DATAPROVIDER', 'llm trading info');
  /*
  let service = runtime.getService("TRADER_STRATEGY") as any;
  while(!service) {
    console.log('llm trading strategy waiting for Trading strategy service...')
    service = runtime.getService("TRADER_STRATEGY") as any;
    if (!service) {
      await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
    } else {
      console.log('llm trading strategy Acquired trading strategy service...')
    }
  }

  let infoService = runtime.getService("TRADER_DATAPROVIDER") as any;
  while(!infoService) {
    console.log('llm trading strategy waiting for Trading info service...')
    infoService = runtime.getService("TRADER_DATAPROVIDER") as any;
    if (!infoService) {
      await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
    } else {
      console.log('llm trading strategy Acquired trading info service...')
    }
  }
  */

  const me = {
    name: 'LLM trading strategy',
  };
  const hndl = await service.register_strategy(me);
  // we want trending
  await infoService.interested_trending(async (results) => {
    console.log('LLM trading strategy', results);
    // update our cache?

    // temp hack
    await generateBuySignal(runtime, service, hndl);
  });
  // sentiment update

  // after we have trending and sentiment
  // then ask the LLM to generate any buy signals

  // priceDeltas? maybe only for open positions
}

async function generateBuySignal(runtime, strategyService, hndl) {
  const sentimentsData = (await runtime.getCache<Sentiment[]>('sentiments')) || [];
  const trendingData = (await runtime.getCache<IToken[]>('tokens_solana')) || [];

  let sentiments = '';

  let idx = 1;
  for (const sentiment of sentimentsData) {
    if (!sentiment?.occuringTokens?.length) continue;
    // FIXME: which chain
    sentiments += `ENTRY ${idx}\nTIME: ${sentiment.timeslot}\nTOKEN ANALYSIS:\n`;
    for (const token of sentiment.occuringTokens) {
      sentiments += `${token.token} - Sentiment: ${token.sentiment}\n${token.reason}\n`;
    }

    sentiments += '\n-------------------\n';
    idx++;
  }

  // Get all trending tokens
  let tokens = '';
  if (!trendingData.length) {
    logger.warn('No trending tokens found in cache');
  } else {
    let index = 1;
    for (const token of trendingData) {
      // FIXME: which chain
      tokens += `ENTRY ${index}\n\nTOKEN SYMBOL: ${token.name}\nTOKEN ADDRESS: ${token.address}\nPRICE: ${token.price}\n24H CHANGE: ${token.price24hChangePercent}\nLIQUIDITY: ${token.liquidity}`;
      tokens += '\n-------------------\n';
      index++;
    }
  }

  const prompt = buyTemplate
    .replace('{{sentiment}}', sentiments)
    .replace('{{trending_tokens}}', tokens);

  // FIXME: chain?
  const requiredFields = ['recommended_buy', 'reason', 'recommend_buy_address'];
  const response = await askLlmObject(
    runtime,
    { prompt, system: 'You are a buy signal analyzer.' },
    requiredFields
  );
  console.log('response', response);
  // verify address for this chain

  // if looks good, get token(s) info (birdeye?)

  // now it's a signal
  // buy on all our wallets
  // check each wallet balance
  // decide path

  // validateTokenForTrading
  // getTokenMarketData
  // calculateOptimalBuyAmount
  // calculateDynamicSlippage
  // wallet.buy

  // open position
  //await strategyService.open_position(hndl, pos)
}
