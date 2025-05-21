import type { IAgentRuntime } from '@elizaos/core';

import { acquireService, askLlmObject } from '../utils';

// agentic personal application? separate strategy

// fixme: an option to mix in autofun unbonded token
// can't be per wallet since we're deciding across multiple wallets
// fixme: include price history data

const buyTemplate = `
I want you to give a crypto buy signal based on both the sentiment analysis as well as the trending tokens.
Only choose a token that occurs in both the Trending Tokens list as well as the Sentiment analysis. This ensures we have the proper symbol, chain and token address.
The sentiment score has a range of -100 to 100, with -100 indicating extreme negativity and 100 indicating extreme positiveness.
Please determine how good of an opportunity this is (how rare and how much potential).
Also let me know what a good amount would be to buy. Buy amount should be a range between 1 and 99% of available balance.
if no sentiment or trending, it's ok to use your feelings instead of your mind.

Sentiment analysis:

{{sentiment}}

Trending tokens:

{{trending_tokens}}

Only return the following JSON and nothing else (even if no sentiment or trending):
{
  recommend_buy: "the symbol of the token for example DEGENAI. can use NULL if nothing strikes you",
  recommend_buy_chain: "which chain the token is on",
  recommend_buy_address: "the address of the token to purchase, for example: Gu3LDkn7Vx3bmCzLafYNKcDxv2mH7YN44NJZFXnypump",
  reason: "the reason why you think this is a good buy, and why you chose the specific amount",
  opportunity_score: "number, for example 50",
  buy_amount: "number, for example: 1",
  exit_conditions: "what conditions in which you'd change your position on this token",
  exit_sentiment_drop_threshold: "what drop in sentiment in which you'd change your position on this token",
  exit_24hvolume_threshold: "what drop in 24h volume in which you'd change your position on this token",
  exit_price_drop_threshold: "what drop in price in which you'd change your position on this token",
  exit_target_price: "what target price do you think we should get out of the position at",
}`;

// exit_24hvolume_threshold/exit_price_drop_threshold what scale?

export async function llmStrategy(runtime: IAgentRuntime) {
  const service = await acquireService(runtime, 'TRADER_STRATEGY', 'llm trading strategy');
  const infoService = await acquireService(runtime, 'TRADER_DATAPROVIDER', 'llm trading info');
  //const solanaService = await acquireService(runtime, 'CHAIN_SOLANA', 'solana service info');

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
  //
}

// maybe should be a class to reuse the service handles
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
  const requiredFields = ['recommend_buy', 'reason', 'recommend_buy_address'];
  const response = await askLlmObject(
    runtime,
    { prompt, system: 'You are a buy signal analyzer.' },
    requiredFields
  );
  console.log('response', response);

  // verify address for this chain (plugin-solana)
  if (response.recommend_buy_chain !== 'solana') {
    // abort
    return;
  }
  const solanaService = await acquireService(runtime, 'chain_solana', 'llm trading strategy');
  if (!solanaService.validateAddress(response.recommend_buy_address)) {
    // handle failure
    // maybe just recall itself
  }

  // if looks good, get token(s) info (birdeye?) (infoService)
  const infoService = await acquireService(runtime, 'TRADER_DATAPROVIDER', 'llm trading info');
  const token = await infoService.getToken(
    response.recommend_buy_chain,
    response.recommend_buy_address
  );

  // validateTokenForTrading (look at liquidity/volume/suspicious atts)

  // now it's a signal
  // assess response, figure what wallet are buying based on balance
  // and scale amount for each wallet based on available balance
  // execute buys on each of wallet

  // calculateOptimalBuyAmount
  // wallet.swap (wallet slippage cfg: 2.5%)
  // wallet.quote
  // calculateDynamicSlippage (require quote)
  // wallet.buy

  // open position
  // set up exit conditions
  //await strategyService.open_position(hndl, pos)
}

// 24h volume delta

async function onSentimentDelta() {
  // get all positions with this chain/token
  // is this wallet/position sentiment delta trigger
}

// what other exit conditions? liquidity, sentiment

async function onPriceDelta() {
  // per token
  // get all positions with this chain/token
  // filter positions, which position change about this price change
  // may trigger some exit/close position action (might not)
  // exit position: wallet.swap, strategyService.close_position(hndl, pos)
}
