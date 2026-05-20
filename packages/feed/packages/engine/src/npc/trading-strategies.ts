export interface TradingStrategyBias {
  followTrend: number;
  contrarian: number;
  random: number;
}

export interface TradingStrategyConfig extends TradingStrategyBias {
  label: string;
  description: string;
}

export const TRADING_STRATEGIES = {
  momentum: {
    label: 'Momentum',
    description:
      'Prefers trading with the trend; will sometimes fade extremes or wait.',
    followTrend: 0.7,
    contrarian: 0.2,
    random: 0.1,
  },
  contrarian: {
    label: 'Contrarian',
    description:
      'Prefers fading crowded trades and betting against extremes; rarely follows the trend.',
    followTrend: 0.2,
    contrarian: 0.7,
    random: 0.1,
  },
  value: {
    label: 'Value',
    description:
      'Looks for mispricing/value and is more selective; mixes trend-following and contrarian entries.',
    followTrend: 0.3,
    contrarian: 0.4,
    random: 0.3,
  },
  random: {
    label: 'Random',
    description:
      'Acts with higher entropy and less consistency; often holds or makes small opportunistic trades.',
    followTrend: 0.33,
    contrarian: 0.33,
    random: 0.34,
  },
} as const satisfies Record<string, TradingStrategyConfig>;

export type NPCTradingStrategyKey = keyof typeof TRADING_STRATEGIES;

function hashStringToUint32(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

export function getNpcTradingStrategy(npcId: string): NPCTradingStrategyKey {
  const keys = Object.keys(TRADING_STRATEGIES) as NPCTradingStrategyKey[];
  if (keys.length === 0) {
    throw new Error('TRADING_STRATEGIES must not be empty');
  }

  const hash = hashStringToUint32(npcId);
  return keys[hash % keys.length]!;
}

export function formatTradingStrategyBias(bias: TradingStrategyBias): string {
  const toPct = (value: number) => `${Math.round(value * 100)}%`;
  return `Follow trend: ${toPct(bias.followTrend)} | Contrarian: ${toPct(
    bias.contrarian
  )} | Random: ${toPct(bias.random)}`;
}
