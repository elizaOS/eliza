import type {
  BroadcastPort,
  CachePort,
  ClockPort,
  FeeConfig,
  FeeProcessor,
  WalletPort,
} from '../shared/common';

export type PredictionSide = 'yes' | 'no';

// Domain records (DB-facing)
export interface QuestionRecord {
  id: string;
  questionNumber?: number;
  text: string;
  status: 'active' | 'resolved' | 'cancelled';
  resolutionDate: Date;
  resolvedOutcome?: boolean | null;
  createdDate?: Date;
}

export interface PredictionMarketRecord {
  id: string;
  question: string;
  description?: string | null;
  gameId?: string | null;
  dayNumber?: number | null;
  yesShares: number;
  noShares: number;
  liquidity: number;
  endDate: Date;
  resolved: boolean;
  resolution?: boolean | null;
  resolutionProofUrl?: string | null;
  resolutionDescription?: string | null;
  status?: 'active' | 'resolved' | 'cancelled';
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PredictionPositionRecord {
  id: string;
  userId: string;
  marketId: string;
  side: PredictionSide;
  shares: number;
  avgPrice: number;
  status?: 'active' | 'closed' | 'resolved' | 'cancelled' | 'voided';
  outcome?: boolean | null;
  pnl?: number;
  resolvedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PredictionPriceSnapshotRecord {
  marketId: string;
  yesPrice: number;
  noPrice: number;
  yesShares: number;
  noShares: number;
  liquidity: number;
  eventType: 'trade' | 'resolution';
  source: 'user_trade' | 'npc_trade' | 'system';
  createdAt?: Date;
}

// DB port (to be implemented by adapter)
export interface PredictionDbPort {
  getMarketById(id: string): Promise<PredictionMarketRecord | null>;
  getMarketsByIds(ids: string[]): Promise<PredictionMarketRecord[]>;
  listMarkets?(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PredictionMarketRecord[]>;
  /** Active (unresolved) row count; used for pagination metadata. */
  countUnresolvedMarkets?(): Promise<number>;
  listUserPositions?(userId: string): Promise<PredictionPositionRecord[]>;
  getQuestion?(idOrNumber: string): Promise<QuestionRecord | null>;
  createMarketFromQuestion(
    question: QuestionRecord,
    initialLiquidity: number,
    options?: {
      description?: string | null;
      gameId?: string | null;
      dayNumber?: number | null;
      initialYesProbability?: number;
    }
  ): Promise<PredictionMarketRecord>;
  updateMarketState(
    marketId: string,
    updates: Partial<
      Pick<
        PredictionMarketRecord,
        | 'yesShares'
        | 'noShares'
        | 'liquidity'
        | 'resolved'
        | 'resolution'
        | 'resolutionProofUrl'
        | 'resolutionDescription'
      >
    >
  ): Promise<PredictionMarketRecord>;
  getPosition(
    userId: string,
    marketId: string,
    side: PredictionSide
  ): Promise<PredictionPositionRecord | null>;
  upsertPosition(
    position: Omit<PredictionPositionRecord, 'id'> & { id?: string }
  ): Promise<PredictionPositionRecord>;
  deletePosition(positionId: string): Promise<void>;
  listPositionsForMarket(marketId: string): Promise<PredictionPositionRecord[]>;
  insertPriceSnapshot(snapshot: PredictionPriceSnapshotRecord): Promise<void>;
}

// DTOs
export interface PredictionBuyInput {
  userId: string;
  marketId: string;
  side: PredictionSide;
  amount: number; // total spent (includes fee)
  /**
   * Maximum allowed absolute odds shift in this single trade (0–1 scale).
   * Defaults to MAX_ODDS_MOVE_PER_TRADE (0.20 = 20 ppt).
   * NPC/agent callers may pass a higher value (e.g. 0.30) for larger positions.
   */
  maxOddsMove?: number;
}

export interface PredictionSellInput {
  userId: string;
  marketId: string;
  shares: number;
  positionId?: string;
}

export interface PredictionResolveInput {
  marketId: string;
  winningSide: PredictionSide;
  resolvedAt?: Date;
  resolutionProofUrl?: string;
  resolutionDescription?: string;
}

export interface PredictionCancelInput {
  marketId: string;
  reason?: string;
  cancelledAt?: Date;
}

export interface PredictionCancelResult {
  marketId: string;
  positionsRefunded: number;
  totalRefunded: number;
}

export interface PredictionTradeResult {
  positionId: string;
  marketId: string;
  side: PredictionSide;
  shares: number;
  avgPrice: number;
  totalCost?: number; // buy
  totalProceeds?: number; // gross proceeds (sell)
  netProceeds?: number; // sell (after fee)
  feePaid: number;
  pnl?: number;
  remainingShares?: number;
  positionClosed?: boolean;
  balance?: number;
  market: {
    yesPrice: number;
    noPrice: number;
    yesShares: number;
    noShares: number;
    priceImpact: number;
    liquidity: number;
  };
}

// Service deps bundle (optional helper)
export interface PredictionServiceDeps {
  db: PredictionDbPort;
  wallet: WalletPort;
  broadcast?: BroadcastPort;
  cache?: CachePort;
  clock?: ClockPort;
  fees: FeeConfig;
  feeProcessor?: FeeProcessor;
  tradeSource?: PredictionPriceSnapshotRecord['source'];
  tradeActorType?: 'user' | 'npc';
}
