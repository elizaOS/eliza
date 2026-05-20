/**
 * Shared simulation configuration and constants.
 *
 * @module engine/config/simulation
 *
 * @description
 * Centralized constants for simulation mode to avoid duplication
 * between GameSimulator, InMemoryStateStore, and other simulation code.
 */

/**
 * Default NPC/Agent names for simulation
 * Used by both fast simulation and training adapters
 */
export const SIMULATION_AGENT_NAMES = [
  'Marcus Chen',
  'Sarah Williams',
  'Alex Rivera',
  'Jordan Lee',
  'Emma Thompson',
  'David Kim',
  'Lisa Patel',
  'Chris Morgan',
  'Rachel Santos',
  'James Wilson',
  'Olivia Brown',
  'Michael Davis',
  'Sophia Martinez',
  'Daniel Taylor',
  'Ava Anderson',
] as const;

/**
 * Sample prediction market questions for simulation
 */
export const SIMULATION_QUESTIONS = [
  'Will TechCorp announce quarterly earnings above expectations?',
  'Will the Fed raise interest rates this month?',
  'Will CryptoToken reach $100 by end of day?',
  'Will the merger between MegaCorp and StartupInc be approved?',
  'Will the new regulation pass the committee vote?',
] as const;

/**
 * Prediction market templates for generating questions
 */
export const PREDICTION_TEMPLATES = [
  {
    q: 'Will {company} stock reach ${target} by end of month?',
    desc: 'Price target prediction',
  },
  {
    q: 'Will {company} announce earnings beat this quarter?',
    desc: 'Earnings prediction',
  },
  {
    q: 'Will {sector} sector outperform market this week?',
    desc: 'Sector performance',
  },
  {
    q: 'Will {company} announce new product launch?',
    desc: 'Product announcement',
  },
] as const;

/**
 * Sample companies for simulation
 */
export const SIMULATION_COMPANIES = [
  { ticker: 'TECH', name: 'TechCorp Industries', sector: 'Technology' },
  { ticker: 'FINA', name: 'FinaBank Holdings', sector: 'Finance' },
  { ticker: 'HLTH', name: 'HealthGen Solutions', sector: 'Healthcare' },
  { ticker: 'ENRG', name: 'EnergyFlow Corp', sector: 'Energy' },
  { ticker: 'RETA', name: 'RetailMax Inc', sector: 'Retail' },
] as const;

/**
 * Clue templates for insider information distribution
 */
export const SIMULATION_CLUE_TEMPLATES = {
  positive: [
    'Insider sources suggest outcome leaning positive',
    'Early indicators point toward YES',
    'Key stakeholder reportedly supportive',
    'Internal documents hint at favorable decision',
    'Reliable sources confirm positive trajectory',
  ],
  negative: [
    'Insider sources suggest outcome leaning negative',
    'Early indicators point toward NO',
    'Key stakeholder reportedly opposed',
    'Internal documents hint at unfavorable decision',
    'Reliable sources confirm negative trajectory',
  ],
} as const;

/**
 * Default simulation configuration
 */
export const DEFAULT_SIMULATION_CONFIG = {
  numAgents: 10,
  numPredictionMarkets: 5,
  numPerpMarkets: 5,
  durationDays: 30,
  startingBalance: 10000,
  liquidityB: 100,
  insiderPercentage: 0.3,
} as const;

/**
 * Agent trading strategies for simulation
 */
export type SimulationStrategy =
  | 'informed'
  | 'momentum'
  | 'contrarian'
  | 'random';

export const SIMULATION_STRATEGIES: readonly SimulationStrategy[] = [
  'informed',
  'momentum',
  'contrarian',
  'random',
] as const;

// =============================================================================
// Runtime Simulation Mock Data (used in isSimulationMode() bypasses)
// =============================================================================

/**
 * Default perpetual market prices for simulation mode.
 * Used across GameLoop, MarketContextService, and tests.
 */
export const SIMULATION_DEFAULT_PRICES = {
  BTCAI: 120000,
  ETHAI: 4000,
  SOLAI: 200,
  TSLAI: 450,
  METAI: 520,
} as const satisfies Record<string, number>;

/**
 * Default prediction markets for simulation mode.
 * Used across MarketDecisionEngine, MarketContextService, and world-context.
 */
export const SIMULATION_PREDICTION_MARKETS = [
  {
    id: 'q1',
    text: 'Will BitcAIn hit $150k by EOM?',
    yesPrice: 65,
    noPrice: 35,
    resolveDays: 14,
    totalVolume: 50000,
  },
  {
    id: 'q2',
    text: 'Will TeslAI announce Model 2?',
    yesPrice: 40,
    noPrice: 60,
    resolveDays: 5,
    totalVolume: 30000,
  },
  {
    id: 'q3',
    text: 'Will Fed cut rates in October?',
    yesPrice: 55,
    noPrice: 45,
    resolveDays: 2,
    totalVolume: 80000,
  },
] as const;

/**
 * Mock recent events/posts for simulation mode.
 * Used in formatRecentEvents() bypasses.
 */
export const SIMULATION_RECENT_EVENTS = [
  { author: 'AIlon Musk', content: 'TeslAI is going to Mars next week' },
  { author: 'Sam AIltman', content: 'AGI achieved internally' },
  { author: 'Vitalik ButerAIn', content: 'Gas fees are too damn high' },
] as const;

/**
 * Mock event-market signals for simulation mode.
 * Used in getEventMarketSignals() bypass.
 */
export const SIMULATION_EVENT_MARKET_SIGNALS = [
  {
    question: 'Will BitcAIn hit $150k?',
    direction: 'up',
    change: '+5.2%',
    reason: 'Positive development announced',
  },
  {
    question: 'Will TeslAI announce Model 2?',
    direction: 'down',
    change: '-3.1%',
    reason: 'Leak suggests delays',
  },
] as const;

/**
 * Helper to get price with fallback to default.
 * Centralizes the price lookup logic used in multiple places.
 */
export function getSimulationPrice(
  ticker: string,
  overrides?: Map<string, number>
): number {
  if (overrides?.has(ticker)) {
    return overrides.get(ticker)!;
  }
  return (SIMULATION_DEFAULT_PRICES as Record<string, number>)[ticker] ?? 100;
}

/**
 * Helper to get all simulation tickers.
 * Returns override keys if provided, otherwise default keys.
 */
export function getSimulationTickers(
  overrides?: Map<string, number>
): string[] {
  if (overrides && overrides.size > 0) {
    return Array.from(overrides.keys());
  }
  return Object.keys(SIMULATION_DEFAULT_PRICES);
}

/**
 * Format prediction markets for prompt context.
 */
export function formatSimulationPredictionMarkets(): string {
  return SIMULATION_PREDICTION_MARKETS.map(
    (m) => `- "${m.text}" (resolves in ${m.resolveDays} days)`
  ).join('\n');
}

/**
 * Format recent events for prompt context.
 */
export function formatSimulationRecentEvents(): string {
  const header = 'Recent developments (last 24h):';
  const events = SIMULATION_RECENT_EVENTS.map(
    (e) => `- ${e.author}: "${e.content}"`
  ).join('\n');
  return `${header}\n${events}`;
}

/**
 * Format event-market signals for prompt context.
 */
export function formatSimulationEventMarketSignals(): string {
  const header = 'EVENT-MARKET SIGNALS:';
  const signals = SIMULATION_EVENT_MARKET_SIGNALS.map(
    (s) =>
      `- "${s.question}" ${s.direction === 'up' ? '↑' : '↓'} ${s.change} (${s.reason}...)`
  ).join('\n');
  return `${header}\n${signals}`;
}

/**
 * Format active markets string for prompts.
 */
export function formatSimulationActiveMarkets(): string {
  const prices = Object.entries(SIMULATION_DEFAULT_PRICES)
    .map(([ticker, price]) => `${ticker} $${price.toLocaleString()}`)
    .join(', ');
  return `Active Markets: ${prices}`;
}
