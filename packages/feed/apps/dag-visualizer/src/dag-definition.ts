export interface DagNodeDef {
  id: string;
  name: string;
  phase: string;
  phaseNumber: number;
  description: string;
}

export interface EdgeDef {
  source: string;
  target: string;
  label: string;
}

export const PHASE_COLORS: Record<string, string> = {
  Bootstrap: '#3b82f6',
  Questions: '#06b6d4',
  Events: '#f97316',
  Markets: '#22c55e',
  Rebalancing: '#eab308',
  ContentMaintenance: '#6b7280',
  Social: '#a855f7',
  Finalize: '#ef4444',
  Agent: '#ec4899', // pink for individual NPC agents
};

export const DAG_NODES: DagNodeDef[] = [
  // Bootstrap
  {
    id: 'init',
    name: 'Initialize',
    phase: 'Bootstrap',
    phaseNumber: 100,
    description: 'Token stats, LLM client setup, game state fetch',
  },
  {
    id: 'bootstrap',
    name: 'Bootstrap Game',
    phase: 'Bootstrap',
    phaseNumber: 100,
    description: 'Create actors, organizations, pools',
  },
  {
    id: 'bootstrap-content',
    name: 'Bootstrap Content',
    phase: 'Bootstrap',
    phaseNumber: 100,
    description: 'Initial relationships, trending tags',
  },
  // Questions
  {
    id: 'questions-load',
    name: 'Load Questions',
    phase: 'Questions',
    phaseNumber: 200,
    description: 'Fetch active questions from DB',
  },
  {
    id: 'questions-init',
    name: 'Gen Questions',
    phase: 'Questions',
    phaseNumber: 200,
    description: 'LLM: Generate prediction questions',
  },
  {
    id: 'question-persistence',
    name: 'Question Persistence',
    phase: 'Questions',
    phaseNumber: 200,
    description: 'Persist newly generated questions',
  },
  {
    id: 'question-topup',
    name: 'Question Top-up',
    phase: 'Questions',
    phaseNumber: 200,
    description: 'LLM: More questions if < 10',
  },
  // Events
  {
    id: 'events',
    name: 'Generate Events',
    phase: 'Events',
    phaseNumber: 300,
    description: 'World events and arc pulse events',
  },
  {
    id: 'narrative-arcs',
    name: 'Narrative Arcs',
    phase: 'Events',
    phaseNumber: 300,
    description: 'Arc phase transitions',
  },
  {
    id: 'timeframed-markets',
    name: 'Timeframes',
    phase: 'Events',
    phaseNumber: 300,
    description: 'Multi-timeframe arcs',
  },
  // Markets
  {
    id: 'market-baseline',
    name: 'Baseline Invest',
    phase: 'Markets',
    phaseNumber: 400,
    description: 'NPC baseline positions',
  },
  {
    id: 'market-decisions',
    name: 'Market Decisions',
    phase: 'Markets',
    phaseNumber: 400,
    description: 'LLM: Batch NPC trading decisions',
  },
  {
    id: 'trade-execution',
    name: 'Trade Execution',
    phase: 'Markets',
    phaseNumber: 400,
    description: 'Execute NPC trades',
  },
  {
    id: 'price-updates',
    name: 'Price Updates',
    phase: 'Markets',
    phaseNumber: 400,
    description: 'Recalculate market prices',
  },
  {
    id: 'market-volatility',
    name: 'Volatility',
    phase: 'Markets',
    phaseNumber: 400,
    description: 'Simulate random price walks',
  },
  // Rebalancing
  {
    id: 'rebalancing',
    name: 'Rebalancing',
    phase: 'Rebalancing',
    phaseNumber: 500,
    description: 'Monitor/rebalance NPC portfolios',
  },
  // Content Maintenance
  {
    id: 'game-state-update',
    name: 'Game State',
    phase: 'ContentMaintenance',
    phaseNumber: 600,
    description: 'DB: lastTickAt, currentDay',
  },
  {
    id: 'widget-caches',
    name: 'Widget Caches',
    phase: 'ContentMaintenance',
    phaseNumber: 600,
    description: 'Top gainers, pools',
  },
  {
    id: 'trending-tags',
    name: 'Trending Tags',
    phase: 'ContentMaintenance',
    phaseNumber: 600,
    description: 'Recalculate trending topics',
  },
  {
    id: 'reputation-sync',
    name: 'Reputation',
    phase: 'ContentMaintenance',
    phaseNumber: 600,
    description: 'On-chain reputation sync',
  },
  // Social
  {
    id: 'relationships',
    name: 'Relationships',
    phase: 'Social',
    phaseNumber: 700,
    description: 'LLM: NPC relationship analysis',
  },
  {
    id: 'group-dynamics',
    name: 'Group Dynamics',
    phase: 'Social',
    phaseNumber: 700,
    description: 'LLM: Group msgs, joins, kicks',
  },
  {
    id: 'alpha-invites',
    name: 'Alpha Invites',
    phase: 'Social',
    phaseNumber: 700,
    description: 'Invite engaged users',
  },
  // Finalize
  {
    id: 'token-stats-finalize',
    name: 'Finalize',
    phase: 'Finalize',
    phaseNumber: 800,
    description: 'Aggregate LLM usage/costs',
  },
];

export const DAG_EDGES: EdgeDef[] = [
  // Bootstrap chain
  { source: 'init', target: 'bootstrap', label: 'config' },
  { source: 'bootstrap', target: 'bootstrap-content', label: 'actors' },

  // Bootstrap -> Questions
  { source: 'bootstrap-content', target: 'questions-load', label: 'ready' },

  // Questions flow
  { source: 'questions-load', target: 'questions-init', label: 'activeQs' },
  { source: 'questions-init', target: 'question-persistence', label: 'newQs' },

  // Questions -> Events
  { source: 'questions-load', target: 'events', label: 'questions[]' },

  // Events flow
  { source: 'events', target: 'narrative-arcs', label: 'worldEvents' },
  {
    source: 'narrative-arcs',
    target: 'timeframed-markets',
    label: 'arcEvents',
  },

  // Events -> Markets
  { source: 'events', target: 'market-baseline', label: 'context' },
  { source: 'events', target: 'market-decisions', label: 'worldCtx' },
  {
    source: 'questions-load',
    target: 'market-decisions',
    label: 'questions[]',
  },

  // Markets chain
  { source: 'market-baseline', target: 'market-decisions', label: 'baseline' },
  {
    source: 'market-decisions',
    target: 'trade-execution',
    label: 'decisions[]',
  },
  { source: 'trade-execution', target: 'price-updates', label: 'trades' },

  // Price -> Rebalancing
  { source: 'price-updates', target: 'rebalancing', label: 'prices' },

  // Volatility from narrative
  { source: 'narrative-arcs', target: 'market-volatility', label: 'events' },
  { source: 'market-volatility', target: 'price-updates', label: 'priceWalks' },

  // Rebalancing -> Content Maintenance
  { source: 'rebalancing', target: 'game-state-update', label: 'complete' },

  // Question topup parallel
  { source: 'questions-load', target: 'question-topup', label: 'count' },

  // Content Maintenance chain
  { source: 'game-state-update', target: 'widget-caches', label: 'day' },
  { source: 'widget-caches', target: 'trending-tags', label: 'caches' },
  { source: 'game-state-update', target: 'reputation-sync', label: 'state' },

  // Content Maintenance -> Social
  { source: 'reputation-sync', target: 'relationships', label: 'reputation' },
  { source: 'relationships', target: 'group-dynamics', label: 'rels' },
  { source: 'group-dynamics', target: 'alpha-invites', label: 'groups' },

  // Social -> Finalize
  { source: 'alpha-invites', target: 'token-stats-finalize', label: 'done' },
  { source: 'trending-tags', target: 'token-stats-finalize', label: 'done' },
];
