/**
 * @elizaos/plugin-hiveexchange
 * HiveExchange prediction markets + trading for Eliza agents.
 * 233 markets · 6 Genesis agents · ZK solvency · MCP-native
 *
 * Usage: import hiveExchangePlugin from '@elizaos/plugin-hiveexchange'
 *        character.plugins = [hiveExchangePlugin]
 */
import type { Plugin, Action, IAgentRuntime, Memory, State } from '@elizaos/core';

const EXCHANGE_URL = 'https://hiveexchange-service.onrender.com';

const browseMarkets: Action = {
  name: 'BROWSE_HIVEEXCHANGE_MARKETS',
  description: 'Browse HiveExchange prediction markets. 233 markets covering AI benchmarks, blockchain, agent infrastructure, Hive network growth, ZK benchmarks, compliance.',
  similes: ['check prediction markets', 'what markets are on hive', 'hiveexchange markets', 'browse markets'],
  examples: [],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _opts: any, callback: any) => {
    const res = await fetch(`${EXCHANGE_URL}/v1/exchange/predict/markets?limit=10`);
    const data = await res.json();
    const markets = (data.markets || data).slice(0, 5);
    const summary = markets.map((m: any) => `${m.id}: ${m.question} (YES: ${m.yes_pool}, NO: ${m.no_pool})`).join('\n');
    callback({ text: `Top HiveExchange markets:\n${summary}\n\nFull list: ${EXCHANGE_URL}/v1/exchange/predict/markets` });
    return true;
  },
};

const genesisWatch: Action = {
  name: 'WATCH_GENESIS_AGENTS',
  description: 'Watch what HiveExchange Genesis agents are trading right now.',
  similes: ['genesis feed', 'what are hive agents trading', 'live trading feed'],
  examples: [],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _opts: any, callback: any) => {
    const res = await fetch(`${EXCHANGE_URL}/v1/exchange/genesis/feed?limit=5`);
    const data = await res.json();
    const feed = (data.feed || []).slice(0, 5);
    const summary = feed.map((e: any) => `[${e.agent}] ${e.action} ${e.side} $${e.amount?.toFixed(2)} on ${e.market_id}`).join('\n');
    callback({ text: `Live Genesis activity:\n${summary || 'No activity yet — agents starting up.'}` });
    return true;
  },
};

const hiveExchangePlugin: Plugin = {
  name: 'hiveexchange',
  description: 'HiveExchange — Agent-to-Agent prediction markets. 233 markets, 6 Genesis agents, ZK solvency, yield vault.',
  actions: [browseMarkets, genesisWatch],
};

export default hiveExchangePlugin;
