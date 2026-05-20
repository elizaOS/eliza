/**
 * Agent Harness Types
 *
 * Core interfaces for the agent training harness.
 */

// ==================== Agent Interface ====================

/**
 * Context provided to agent for decision making
 */
export interface AgentContext {
  balance: number;
  positions: Position[];
  markets: Market[];
  posts: Post[];
  tick: number;
  archetype?: ArchetypeConfig;
}

/**
 * Decision made by an agent
 */
export interface AgentDecision {
  action: ActionType;
  params: Record<string, unknown>;
  reasoning: string;
}

/**
 * Result of executing an action
 */
export interface ActionResult {
  success: boolean;
  action: ActionType;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Core agent interface - implement this to create a trainable agent
 */
export interface TrainableAgent {
  /** Unique identifier for this agent type */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Language implementation */
  readonly language: 'typescript' | 'python';

  /** Initialize the agent with configuration */
  initialize(config: AgentConfig): Promise<void>;

  /** Make a decision given context */
  decide(context: AgentContext): Promise<AgentDecision>;

  /** Execute an action (optional - harness can execute) */
  execute?(
    decision: AgentDecision,
    client: A2AClientInterface
  ): Promise<ActionResult>;

  /** Called at end of training run */
  cleanup?(): Promise<void>;
}

// ==================== A2A Client Interface ====================

export interface A2AClientInterface {
  // Portfolio
  getBalance(): Promise<{ balance: number; currency: string }>;
  getPositions(): Promise<{ positions: Position[] }>;
  getPortfolio(): Promise<{
    balance: number;
    positions: Position[];
    pnl: number;
  }>;

  // Markets
  getMarkets(): Promise<{ predictions: Market[]; perps: Market[] }>;
  getMarketData(marketId: string): Promise<Market>;
  buyShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    amount: number
  ): Promise<Trade>;
  sellShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    shares: number
  ): Promise<Trade>;

  // Social
  getFeed(limit?: number): Promise<{ posts: Post[] }>;
  createPost(content: string): Promise<Post>;
  likePost(postId: string): Promise<{ success: boolean; likesCount: number }>;
  commentPost(postId: string, content: string): Promise<{ id: string }>;

  // Discovery
  discover(): Promise<{ agents: AgentInfo[] }>;
  searchUsers(query: string): Promise<{ users: UserInfo[] }>;

  // Stats
  getStats(): Promise<SystemStats>;
  getLeaderboard(limit?: number): Promise<{ entries: LeaderboardEntry[] }>;

  // Notifications
  getNotifications(): Promise<{ notifications: Notification[] }>;
}

// ==================== Data Types ====================

export interface Position {
  id: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  currentPrice?: number;
  pnl?: number;
}

export interface Market {
  id: string;
  question: string;
  description?: string;
  yesPrice: number;
  noPrice: number;
  status: string;
}

export interface Post {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  likesCount: number;
  createdAt: string;
}

export interface Trade {
  id: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  shares: number;
  price: number;
  totalCost: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  walletAddress: string;
}

export interface UserInfo {
  id: string;
  displayName: string;
  username?: string;
}

export interface SystemStats {
  totalAgents: number;
  totalMarkets: number;
  totalVolume: number;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  pnl: number;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  isRead: boolean;
}

// ==================== Actions ====================

export type ActionType =
  | 'BUY_YES'
  | 'BUY_NO'
  | 'SELL_SHARES'
  | 'CREATE_POST'
  | 'LIKE_POST'
  | 'COMMENT_POST'
  | 'VIEW_FEED'
  | 'DISCOVER_AGENTS'
  | 'SEARCH_USERS'
  | 'CHECK_LEADERBOARD'
  | 'CHECK_NOTIFICATIONS'
  | 'VIEW_MARKET_DATA'
  | 'HOLD';

// ==================== Archetype ====================

export interface ArchetypeTraits {
  greed: number;
  fear: number;
  patience: number;
  confidence: number;
  ethics: number;
}

export interface ArchetypeConfig {
  id: string;
  name: string;
  description: string;
  system: string;
  traits: ArchetypeTraits;
  riskTolerance: number;
  actionWeights: {
    trade: number;
    post: number;
    research: number;
    social: number;
  };
}

// ==================== Agent Config ====================

export interface AgentConfig {
  /** Base URL of A2A server */
  a2aUrl: string;

  /** Private key for wallet */
  privateKey: string;

  /** Archetype configuration (optional) */
  archetype?: ArchetypeConfig;

  /** Agent display name */
  name?: string;

  /** Tick interval in ms */
  tickInterval?: number;

  /** Custom configuration for specific agent types */
  custom?: Record<string, unknown>;
}

// ==================== Trajectory ====================

export interface TrajectoryStep {
  tick: number;
  timestamp: string;
  context: AgentContext;
  decision: AgentDecision;
  result: ActionResult;
  reward?: number;
}

export interface Trajectory {
  id: string;
  agentId: string;
  archetype?: string;
  startTime: string;
  endTime?: string;
  steps: TrajectoryStep[];
  totalReward: number;
  metadata?: Record<string, unknown>;
}

// ==================== Harness Config ====================

/**
 * Optional factory that returns an A2AClientInterface for a given agent
 * instance. When provided, the harness calls this instead of building a
 * default HarnessA2AClient. Use to inject BabylonProductionClient or
 * SimulationA2AAdapter per instance.
 */
export type ClientFactory = (instanceIndex: number) => A2AClientInterface;

export interface HarnessConfig {
  /**
   * A2A server URL.
   * Used only when `clientFactory` is omitted (default HarnessA2AClient).
   */
  a2aUrl: string;

  /** Agents to run */
  agents: TrainableAgent[];

  /** Archetypes to apply (cycles through agents) */
  archetypes: ArchetypeConfig[];

  /** Number of instances per agent/archetype combo */
  instancesPerAgent: number;

  /** Maximum parallel agents */
  parallelAgents: number;

  /** Ticks per agent instance */
  ticksPerAgent: number;

  /** Tick interval in ms */
  tickInterval: number;

  /** Enable trajectory recording */
  recordTrajectories: boolean;

  /** Output directory for trajectories */
  outputDir?: string;

  /**
   * Optional factory for custom A2A clients.
   * Receives the instance index (0-based) so each instance can get
   * its own client (e.g. SimulationA2AAdapter with separate state).
   */
  clientFactory?: ClientFactory;
}

export interface HarnessResult {
  agentsRun: number;
  totalTicks: number;
  trajectories: Trajectory[];
  duration: number;
  errors: string[];
  stats: {
    byArchetype: Record<
      string,
      {
        agents: number;
        ticks: number;
        avgReward: number;
      }
    >;
    byAgent: Record<
      string,
      {
        instances: number;
        ticks: number;
        avgReward: number;
      }
    >;
  };
}
