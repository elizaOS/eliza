/**
 * PostgreSQL Storage Provider
 *
 * For production use with PostgreSQL database.
 *
 * ARCHITECTURE NOTE:
 * This provider is intentionally a thin wrapper that delegates to @feed/db.
 * The port-based abstraction is primarily useful for:
 * - JSON mode: Simulation/training without a database
 * - Memory mode: Fast unit testing
 *
 * For production PostgreSQL access, most code uses @feed/db directly because:
 * 1. The Drizzle ORM provides excellent type safety
 * 2. Complex queries benefit from direct SQL access
 * 3. The db client has built-in connection pooling, retries, and RLS support
 *
 * If you need the port abstraction for production, consider:
 * - Using @feed/db directly (recommended)
 * - Implementing specific adapters as needed
 *
 * The JSON storage provider (packages/core/storage/adapters/json) provides a
 * complete implementation of all ports for offline simulation and training.
 */

import { checkDatabaseHealth, closeDatabase } from "@feed/db";
import type { ActorPort, OrganizationPort } from "../../ports/actors";
import type { AgentPort } from "../../ports/agents";
import type { GamePort } from "../../ports/game";
import type { MarketPort } from "../../ports/markets";
import type { PostPort } from "../../ports/posts";
import type { QuestionPort } from "../../ports/questions";
import type {
  IStorageProvider,
  StorageMode,
} from "../../ports/storage-provider";
import type { TradingPort } from "../../ports/trading";
import type { UserPort } from "../../ports/users";

const UNSUPPORTED_PORT_MSG =
  "PostgresStorageProvider port methods are unavailable in this adapter. " +
  "For production, use @feed/db directly which provides: " +
  "• Full Drizzle ORM type safety " +
  "• Connection pooling and retries " +
  "• RLS context support (asUser, asSystem) " +
  "• Direct SQL for complex queries. " +
  'For simulation/training, use createStorageProvider({ mode: "json" }).';

// Port methods that provide helpful guidance
class StubActorPort implements ActorPort {
  getActor(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getActors(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getActorsByTier(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getActorState(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAllActorStates(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  upsertActorState(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateActorBalance(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateActorReputation(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

class StubOrganizationPort implements OrganizationPort {
  getOrganization(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getOrganizations(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getOrganizationsByType(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getOrganizationByTicker(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getOrganizationState(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAllOrganizationStates(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  upsertOrganizationState(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateOrganizationPrice(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

class StubAgentPort implements AgentPort {
  getAgentConfig(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createAgentConfig(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateAgentConfig(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  deleteAgentConfig(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAgentLogs(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createAgentLog(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAgentMessages(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createAgentMessage(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAgentPointsTransactions(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createAgentPointsTransaction(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAgentTrades(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createAgentTrade(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  listAgentsWithAutonomousTrading(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

class StubGamePort implements GamePort {
  getGameState(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  initializeGame(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateGameState(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAllGames(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getRecentEvents(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createEvent(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getEventsByDay(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  recordPriceUpdate(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  recordDailySnapshot(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getPriceHistory(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getDailySnapshots(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

class StubMarketPort implements MarketPort {
  getMarket(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getActiveMarkets(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getMarketsByCategory(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createMarket(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateMarket(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  resolveMarket(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateMarketShares(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getMarketSnapshots(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  recordMarketSnapshot(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

class StubPostPort implements PostPort {
  getPost(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getRecentPosts(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getPostsByAuthor(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getPostsByType(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createPost(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createManyPosts(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updatePost(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  deletePost(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  incrementLikeCount(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  decrementLikeCount(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  incrementCommentCount(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  incrementRepostCount(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getPostComments(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getTotalPosts(): Promise<number> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

class StubQuestionPort implements QuestionPort {
  getQuestion(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getQuestionByNumber(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getActiveQuestions(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getQuestionsToResolve(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAllQuestions(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createQuestion(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  resolveQuestion(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateQuestion(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getActiveQuestionCount(): Promise<number> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

class StubTradingPort implements TradingPort {
  getPool(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getPoolByActorId(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createPool(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updatePool(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getPosition(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getOpenPositions(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getOpenPositionsByMarket(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getOpenPositionsByTicker(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createPosition(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updatePosition(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  closePosition(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getNpcTrades(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createNpcTrade(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getRecentNpcTrades(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

class StubUserPort implements UserPort {
  getUser(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getUserByUsername(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getUserByWallet(): Promise<null> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createUser(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateUser(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  deleteUser(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAgentUsers(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getAgentsByManager(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateUserBalance(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  updateUserReputationPoints(): Promise<void> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  createPointsTransaction(): Promise<never> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  getUserPointsTransactions(): Promise<[]> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
  userExists(): Promise<boolean> {
    throw new Error(UNSUPPORTED_PORT_MSG);
  }
}

export class PostgresStorageProvider implements IStorageProvider {
  readonly mode: StorageMode = "postgres";

  readonly actors: ActorPort = new StubActorPort();
  readonly organizations: OrganizationPort = new StubOrganizationPort();
  readonly agents: AgentPort = new StubAgentPort();
  readonly game: GamePort = new StubGamePort();
  readonly markets: MarketPort = new StubMarketPort();
  readonly posts: PostPort = new StubPostPort();
  readonly questions: QuestionPort = new StubQuestionPort();
  readonly trading: TradingPort = new StubTradingPort();
  readonly users: UserPort = new StubUserPort();

  async initialize(): Promise<void> {
    // Verify database connection is healthy
    const healthy = await checkDatabaseHealth();
    if (!healthy) {
      throw new Error(
        "PostgresStorageProvider: Database connection failed. " +
          "Check DATABASE_URL environment variable.",
      );
    }
  }

  async shutdown(): Promise<void> {
    await closeDatabase();
  }

  async isHealthy(): Promise<boolean> {
    return checkDatabaseHealth();
  }
}
