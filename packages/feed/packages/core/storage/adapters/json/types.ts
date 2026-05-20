/**
 * JSON Storage Types
 *
 * Internal types for the JSON file storage adapter.
 */

import type {
  AgentLogRecord,
  AgentMessageRecord,
  AgentPointsTransactionRecord,
} from "../../ports/agents";
import type { PointsTransactionRecord } from "../../ports/users";
import type {
  ActorRecord,
  ActorStateRecord,
  AgentConfigRecord,
  AgentTradeRecord,
  GameRecord,
  MarketSnapshotRecord,
  NpcTradeRecord,
  OrganizationRecord,
  OrganizationStateRecord,
  PoolPositionRecord,
  PoolRecord,
  PostRecord,
  PredictionMarketRecord,
  QuestionRecord,
  StockPriceRecord,
  UserRecord,
  WorldEventRecord,
} from "../../types";

/**
 * Complete storage state that can be serialized to JSON.
 */
export interface JsonStorageState {
  metadata: {
    version: string;
    createdAt: string;
    updatedAt: string;
    mode: "simulation" | "training" | "debug";
  };

  // Core entities
  actors: Record<string, ActorRecord>;
  actorStates: Record<string, ActorStateRecord>;
  organizations: Record<string, OrganizationRecord>;
  organizationStates: Record<string, OrganizationStateRecord>;

  // Users and agents
  users: Record<string, UserRecord>;
  agentConfigs: Record<string, AgentConfigRecord>;
  agentLogs: AgentLogRecord[];
  agentMessages: AgentMessageRecord[];
  agentPointsTransactions: AgentPointsTransactionRecord[];
  agentTrades: AgentTradeRecord[];
  pointsTransactions: PointsTransactionRecord[];

  // Content
  posts: Record<string, PostRecord>;

  // Questions and markets
  questions: Record<string, QuestionRecord>;
  markets: Record<string, PredictionMarketRecord>;
  marketSnapshots: MarketSnapshotRecord[];

  // Trading
  pools: Record<string, PoolRecord>;
  positions: Record<string, PoolPositionRecord>;
  npcTrades: NpcTradeRecord[];

  // Game state
  game: GameRecord | null;
  worldEvents: WorldEventRecord[];
  stockPrices: StockPriceRecord[];

  // Counters for ID generation
  counters: {
    post: number;
    question: number;
    market: number;
    position: number;
    trade: number;
    event: number;
    snapshot: number;
    log: number;
    message: number;
    transaction: number;
  };
}

/**
 * Default empty state.
 */
export function createEmptyState(): JsonStorageState {
  return {
    metadata: {
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: "simulation",
    },
    actors: {},
    actorStates: {},
    organizations: {},
    organizationStates: {},
    users: {},
    agentConfigs: {},
    agentLogs: [],
    agentMessages: [],
    agentPointsTransactions: [],
    agentTrades: [],
    pointsTransactions: [],
    posts: {},
    questions: {},
    markets: {},
    marketSnapshots: [],
    pools: {},
    positions: {},
    npcTrades: [],
    game: null,
    worldEvents: [],
    stockPrices: [],
    counters: {
      post: 0,
      question: 0,
      market: 0,
      position: 0,
      trade: 0,
      event: 0,
      snapshot: 0,
      log: 0,
      message: 0,
      transaction: 0,
    },
  };
}
