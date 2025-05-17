import type { IAgentRuntime } from '@elizaos/core';

import { acquireService, askLlmObject } from '../utils';

export async function copyStrategy(runtime: IAgentRuntime) {
  const service = await acquireService(runtime, 'TRADER_STRATEGY', 'copy trading strategy');
  const infoService = await acquireService(runtime, 'TRADER_DATAPROVIDER', 'copy trading info');

  const me = {
    name: 'Copy trading strategy',
  };
  const hndl = await service.register_strategy(me);

  // ok which wallets do we need to set up listeners on?
}

async function onWalletEvent(runtime, strategyService, hndl) {
  // what wallets are using this strategy
  // who's following this wallet
  // if no one, deregister event
  // scale amount for each specific interested wallet
  // buy: (maybe based on available balance)
  // sell: can be scaled based on position info, as long we record the OG wallet amount (and have our amount)
  // execute trade, open/close positions:
  // verify address for this chain
  // if looks good, get token(s) info (birdeye?)
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
