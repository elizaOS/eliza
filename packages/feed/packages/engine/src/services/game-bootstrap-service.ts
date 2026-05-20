/**
 * Game Bootstrap Service
 *
 * Ensures all game data is properly seeded and synced at tick start.
 * Replaces the need for manual seeding scripts.
 */

import { getSyntheticPerpQuoteState } from '@babylon/core/markets/perps';
import {
  actorState,
  db,
  eq,
  games,
  generateSnowflakeId,
  inArray,
  organizationState,
  perpMarketSnapshots,
  pools,
  rssFeedSources,
  sql,
  users,
} from '@babylon/db';
import type { ActorTier } from '@babylon/shared';
import { logger } from '@babylon/shared';
import { DEFAULT_RSS_SOURCES } from '../config/rss-sources';
import { CapitalAllocationService } from './capital-allocation-service';
import { StaticDataRegistry } from './static-data-registry';

// Minimum balance thresholds by tier
const MINIMUM_BALANCE_BY_TIER: Record<string, number> = {
  S_TIER: 50000,
  A_TIER: 25000,
  B_TIER: 10000,
  C_TIER: 5000,
};

const DEFAULT_MINIMUM_BALANCE = 5000;
const MAX_TOP_UP_AMOUNT = 100000;

/** Funding interval in hours for perpetual markets */
const FUNDING_INTERVAL_HOURS = 8;
/** Funding interval in milliseconds */
const FUNDING_INTERVAL_MS = FUNDING_INTERVAL_HOURS * 60 * 60 * 1000;

export interface GameBootstrapResult {
  actorsCreated: number;
  actorsUpdated: number;
  actorsToppedUp: number;
  npcUsersCreated: number;
  organizationsCreated: number;
  organizationsUpdated: number;
  poolsCreated: number;
  rssFeedsCreated: number;
  perpMarketsCreated: number;
  gameStateInitialized: boolean;
  totalTopUpAmount: number;
}

export class GameBootstrapService {
  private static lastBootstrapTime = 0;
  private static BOOTSTRAP_COOLDOWN_MS = 60000;
  private static isBootstrapping = false;

  private static getFirstPositivePrice(
    ...candidates: Array<number | null | undefined>
  ): number | null {
    for (const candidate of candidates) {
      if (
        typeof candidate === 'number' &&
        Number.isFinite(candidate) &&
        candidate > 0
      ) {
        return candidate;
      }
    }
    return null;
  }

  private static async resolveCanonicalOrganizationSeedPrice(org: {
    id: string;
    initialPrice: number | null;
  }): Promise<number> {
    let realPrice: number | null = null;
    try {
      const { realPriceService } = await import('./real-price-service');
      const candidate = realPriceService.getBasePriceForOrg(org.id);
      if (
        typeof candidate === 'number' &&
        Number.isFinite(candidate) &&
        candidate > 0
      ) {
        realPrice = candidate;
      }
    } catch {
      // Real price service not available — use static price fallback.
    }

    return this.getFirstPositivePrice(realPrice, org.initialPrice) ?? 100;
  }

  static async bootstrapIfNeeded(): Promise<GameBootstrapResult | null> {
    const now = Date.now();

    // Check if we've bootstrapped recently
    if (now - this.lastBootstrapTime < this.BOOTSTRAP_COOLDOWN_MS) {
      return null;
    }

    // Prevent concurrent bootstrapping
    if (this.isBootstrapping) {
      return null;
    }

    this.isBootstrapping = true;
    this.lastBootstrapTime = now;

    const result: GameBootstrapResult = {
      actorsCreated: 0,
      actorsUpdated: 0,
      actorsToppedUp: 0,
      npcUsersCreated: 0,
      organizationsCreated: 0,
      organizationsUpdated: 0,
      poolsCreated: 0,
      rssFeedsCreated: 0,
      perpMarketsCreated: 0,
      gameStateInitialized: false,
      totalTopUpAmount: 0,
    };

    try {
      // Get static data from registry (no file loading needed)
      const staticActors = StaticDataRegistry.getAllActors();
      const staticOrgs = StaticDataRegistry.getAllOrganizations();

      // Get existing database state from state tables
      const [existingActorStates, existingOrgStates] = await Promise.all([
        db.select({ id: actorState.id }).from(actorState),
        db.select({ id: organizationState.id }).from(organizationState),
      ]);
      const existingActorIds = new Set(existingActorStates.map((a) => a.id));
      const existingOrgIds = new Set(existingOrgStates.map((o) => o.id));

      // 1. Sync actor states (only dynamic data)
      for (const actor of staticActors) {
        if (!existingActorIds.has(actor.id)) {
          await this.seedActorState(actor);
          result.actorsCreated++;
        }
      }

      // 2. Sync organization states (only dynamic data)
      for (const org of staticOrgs) {
        if (!existingOrgIds.has(org.id)) {
          await this.seedOrganizationState(org);
          result.organizationsCreated++;
        }
      }

      // 3. Ensure minimum balances
      const topUpResult = await this.ensureMinimumBalances();
      result.actorsToppedUp = topUpResult.count;
      result.totalTopUpAmount = topUpResult.totalAmount;

      // 4. Ensure pools exist
      result.poolsCreated = await this.ensureActorPools();

      // 4b. Ensure NPC User records exist (for wallet/payout operations)
      result.npcUsersCreated = await this.ensureNpcUsers(staticActors);

      // 5. Ensure game state exists
      result.gameStateInitialized = await this.ensureGameState();

      // 6. Ensure RSS feeds
      result.rssFeedsCreated = await this.ensureRSSFeeds();

      // 7. Ensure perp market snapshots exist for all tradeable organizations
      result.perpMarketsCreated = await this.ensurePerpMarketSnapshots();

      // Log summary if anything changed
      const hasChanges =
        result.actorsCreated > 0 ||
        result.actorsToppedUp > 0 ||
        result.npcUsersCreated > 0 ||
        result.organizationsCreated > 0 ||
        result.poolsCreated > 0 ||
        result.rssFeedsCreated > 0 ||
        result.perpMarketsCreated > 0 ||
        result.gameStateInitialized;

      if (hasChanges) {
        logger.info('Game bootstrap complete', result, 'GameBootstrapService');
      }

      return result;
    } catch (error) {
      logger.error(
        'Game bootstrap failed',
        { error: String(error) },
        'GameBootstrapService'
      );
      throw error;
    } finally {
      this.isBootstrapping = false;
    }
  }

  static async forceFullSync(): Promise<GameBootstrapResult> {
    this.lastBootstrapTime = 0;
    this.isBootstrapping = false;

    const result: GameBootstrapResult = {
      actorsCreated: 0,
      actorsUpdated: 0,
      actorsToppedUp: 0,
      npcUsersCreated: 0,
      organizationsCreated: 0,
      organizationsUpdated: 0,
      poolsCreated: 0,
      rssFeedsCreated: 0,
      perpMarketsCreated: 0,
      gameStateInitialized: false,
      totalTopUpAmount: 0,
    };

    // Get static data from registry
    const staticActors = StaticDataRegistry.getAllActors();
    const staticOrgs = StaticDataRegistry.getAllOrganizations();

    // Sync all actor states (update existing, create missing)
    for (const actor of staticActors) {
      const syncResult = await this.syncActorState(actor);
      if (syncResult.created) result.actorsCreated++;
      if (syncResult.updated) result.actorsUpdated++;
    }

    // Sync all organization states
    for (const org of staticOrgs) {
      const syncResult = await this.syncOrganizationState(org);
      if (syncResult.created) result.organizationsCreated++;
      if (syncResult.updated) result.organizationsUpdated++;
    }

    // Ensure minimum balances
    const topUpResult = await this.ensureMinimumBalances();
    result.actorsToppedUp = topUpResult.count;
    result.totalTopUpAmount = topUpResult.totalAmount;

    result.poolsCreated = await this.ensureActorPools();

    // Ensure NPC User records exist (for wallet/payout operations)
    result.npcUsersCreated = await this.ensureNpcUsers(staticActors);

    result.gameStateInitialized = await this.ensureGameState();
    result.rssFeedsCreated = await this.ensureRSSFeeds();
    result.perpMarketsCreated = await this.ensurePerpMarketSnapshots();

    logger.info('Force full sync complete', result, 'GameBootstrapService');
    return result;
  }

  private static async seedActorState(actor: {
    id: string;
    name: string;
    tier: ActorTier | null;
    domain: string[];
  }): Promise<void> {
    const capital = CapitalAllocationService.calculateCapital({
      id: actor.id,
      name: actor.name,
      description: undefined,
      domain: actor.domain,
      tier: actor.tier ?? undefined,
    });

    await db.insert(actorState).values({
      id: actor.id,
      tradingBalance: capital.tradingBalance.toString(),
      reputationPoints: capital.reputationPoints,
      hasPool: false,
      updatedAt: new Date(),
    });

    logger.debug(
      `Seeded actor state ${actor.name} with $${capital.tradingBalance}`,
      { actorId: actor.id },
      'GameBootstrapService'
    );
  }

  private static async syncActorState(actor: {
    id: string;
    name: string;
    tier: ActorTier | null;
    domain: string[];
  }): Promise<{ created: boolean; updated: boolean }> {
    const existing = await db
      .select({
        id: actorState.id,
        tradingBalance: actorState.tradingBalance,
      })
      .from(actorState)
      .where(eq(actorState.id, actor.id))
      .limit(1);

    if (existing.length === 0) {
      await this.seedActorState(actor);
      return { created: true, updated: false };
    }

    const existingState = existing[0];
    if (!existingState) return { created: false, updated: false };

    const tier = actor.tier || 'C_TIER';
    const minimumBalance =
      MINIMUM_BALANCE_BY_TIER[tier] || DEFAULT_MINIMUM_BALANCE;
    const currentBalance = Number(existingState.tradingBalance) || 0;

    // Only update balance if below minimum
    if (currentBalance < minimumBalance) {
      await db
        .update(actorState)
        .set({
          tradingBalance: minimumBalance.toString(),
          updatedAt: new Date(),
        })
        .where(eq(actorState.id, actor.id));
    }

    return { created: false, updated: true };
  }

  private static async seedOrganizationState(org: {
    id: string;
    name: string;
    initialPrice: number | null;
  }): Promise<void> {
    const effectivePrice =
      await this.resolveCanonicalOrganizationSeedPrice(org);

    await db.insert(organizationState).values({
      id: org.id,
      currentPrice: effectivePrice,
      basePrice: effectivePrice,
      updatedAt: new Date(),
    });

    logger.debug(
      `Seeded organization state ${org.name}`,
      { orgId: org.id, price: effectivePrice },
      'GameBootstrapService'
    );
  }

  private static async syncOrganizationState(org: {
    id: string;
    name: string;
    initialPrice: number | null;
  }): Promise<{ created: boolean; updated: boolean }> {
    const existing = await db
      .select({
        id: organizationState.id,
        currentPrice: organizationState.currentPrice,
        basePrice: organizationState.basePrice,
      })
      .from(organizationState)
      .where(eq(organizationState.id, org.id))
      .limit(1);

    if (existing.length === 0) {
      await this.seedOrganizationState(org);
      return { created: true, updated: false };
    }

    const existingState = existing[0];
    if (!existingState) return { created: false, updated: false };

    const currentPrice =
      typeof existingState.currentPrice === 'number'
        ? existingState.currentPrice
        : Number(existingState.currentPrice);
    const basePrice =
      typeof existingState.basePrice === 'number'
        ? existingState.basePrice
        : Number(existingState.basePrice);

    const hasInvalidCurrentPrice =
      !Number.isFinite(currentPrice) || currentPrice <= 0;
    const hasInvalidBasePrice = !Number.isFinite(basePrice) || basePrice <= 0;

    if (hasInvalidCurrentPrice || hasInvalidBasePrice) {
      const canonicalPrice =
        await this.resolveCanonicalOrganizationSeedPrice(org);
      await db
        .update(organizationState)
        .set({
          currentPrice: hasInvalidCurrentPrice ? canonicalPrice : currentPrice,
          basePrice: hasInvalidBasePrice ? canonicalPrice : basePrice,
          updatedAt: new Date(),
        })
        .where(eq(organizationState.id, org.id));

      logger.warn(
        `Repaired invalid organization state for ${org.name}`,
        {
          orgId: org.id,
          previousCurrentPrice: existingState.currentPrice,
          previousBasePrice: existingState.basePrice,
          canonicalPrice,
        },
        'GameBootstrapService'
      );

      return { created: false, updated: true };
    }

    return { created: false, updated: false };
  }

  private static async ensureMinimumBalances(): Promise<{
    count: number;
    totalAmount: number;
  }> {
    // Get all actor states with their balances
    const allActorStates = await db
      .select({
        id: actorState.id,
        tradingBalance: actorState.tradingBalance,
      })
      .from(actorState);

    let toppedUpCount = 0;
    let totalTopUp = 0;

    for (const state of allActorStates) {
      // Get static actor data for tier info
      const staticActor = StaticDataRegistry.getActor(state.id);
      const currentBalance = Number(state.tradingBalance) || 0;
      const tier = staticActor?.tier || 'C_TIER';
      const minimumBalance =
        MINIMUM_BALANCE_BY_TIER[tier] || DEFAULT_MINIMUM_BALANCE;

      if (currentBalance < minimumBalance) {
        const deficit = minimumBalance - currentBalance;
        const topUpAmount = Math.min(deficit, MAX_TOP_UP_AMOUNT);

        await db
          .update(actorState)
          .set({
            tradingBalance: sql`${actorState.tradingBalance} + ${topUpAmount}`,
            updatedAt: new Date(),
          })
          .where(eq(actorState.id, state.id));

        toppedUpCount++;
        totalTopUp += topUpAmount;

        logger.debug(
          `Topped up ${staticActor?.name ?? state.id}: $${currentBalance} → +$${topUpAmount}`,
          { actorId: state.id, topUpAmount },
          'GameBootstrapService'
        );
      }
    }

    return { count: toppedUpCount, totalAmount: totalTopUp };
  }

  private static async ensureActorPools(): Promise<number> {
    // Get actor states that don't have pools
    const actorStatesWithoutPools = await db
      .select({
        id: actorState.id,
        tradingBalance: actorState.tradingBalance,
      })
      .from(actorState)
      .where(eq(actorState.hasPool, false));

    let created = 0;

    for (const state of actorStatesWithoutPools) {
      const poolId = state.id;
      const balance = Number(state.tradingBalance) || 10000;
      const staticActor = StaticDataRegistry.getActor(state.id);

      const existingPool = await db
        .select({ id: pools.id })
        .from(pools)
        .where(eq(pools.id, poolId))
        .limit(1);

      if (existingPool.length === 0) {
        await db.insert(pools).values({
          id: poolId,
          name: `${staticActor?.name ?? state.id}'s Pool`,
          npcActorId: state.id,
          totalValue: balance.toString(),
          totalDeposits: balance.toString(),
          availableBalance: balance.toString(),
          lifetimePnL: '0',
          performanceFeeRate: 0.05,
          totalFeesCollected: '0',
          isActive: true,
          status: 'ACTIVE',
          updatedAt: new Date(),
        });

        await db
          .update(actorState)
          .set({ hasPool: true, updatedAt: new Date() })
          .where(eq(actorState.id, state.id));

        created++;
      }
    }

    return created;
  }

  /**
   * Ensure User records exist for NPC actors
   * This allows NPCs to receive wallet credits during payouts
   */
  private static async ensureNpcUsers(
    staticActors: Array<{ id: string; name: string }>
  ): Promise<number> {
    if (staticActors.length === 0) {
      return 0;
    }

    const actorIds = staticActors.map((a) => a.id);

    // Get existing NPC users
    const existingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, actorIds));

    const existingUserIds = new Set(existingUsers.map((u) => u.id));

    // Create User records for NPCs that don't have them
    let created = 0;
    const now = new Date();

    for (const actor of staticActors) {
      if (existingUserIds.has(actor.id)) {
        continue;
      }

      await db.insert(users).values({
        id: actor.id,
        displayName: actor.name,
        username: actor.id, // Use actor ID as username
        isActor: true,
        virtualBalance: '10000', // NPCs get starting balance
        totalDeposited: '10000',
        totalWithdrawn: '0',
        lifetimePnL: '0',
        createdAt: now,
        updatedAt: now,
      });

      created++;
    }

    if (created > 0) {
      logger.info(
        `Created ${created} NPC User records`,
        { created },
        'GameBootstrapService'
      );
    }

    return created;
  }

  private static async ensureGameState(): Promise<boolean> {
    const existingGame = await db
      .select()
      .from(games)
      .where(eq(games.isContinuous, true))
      .limit(1);

    if (existingGame.length === 0) {
      const now = new Date();
      const gameId = await generateSnowflakeId();

      await db.insert(games).values({
        id: gameId,
        isContinuous: true,
        isRunning: true,
        currentDate: now,
        currentDay: 1,
        speed: 60000,
        startedAt: now,
        updatedAt: now,
      });

      logger.info('Game state initialized', undefined, 'GameBootstrapService');
      return true;
    }

    // Ensure game is running
    const game = existingGame[0];
    if (game && !game.isRunning) {
      await db
        .update(games)
        .set({
          isRunning: true,
          startedAt: game.startedAt || new Date(),
          pausedAt: null,
        })
        .where(eq(games.id, game.id));
      return true;
    }

    return false;
  }

  /** Seeds rssFeedSources from DEFAULT_RSS_SOURCES (config). WHY config: single place to add/edit feed URLs; runtime enable/disable remains in DB. */
  private static async ensureRSSFeeds(): Promise<number> {
    let created = 0;

    for (const feed of DEFAULT_RSS_SOURCES) {
      const existing = await db
        .select({ id: rssFeedSources.id })
        .from(rssFeedSources)
        .where(eq(rssFeedSources.feedUrl, feed.feedUrl))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(rssFeedSources).values({
          id: await generateSnowflakeId(),
          name: feed.name,
          feedUrl: feed.feedUrl,
          category: feed.category,
          updatedAt: new Date(),
        });
        created++;
      }
    }

    return created;
  }

  /**
   * Ensure perp market snapshots exist for all organizations with tickers.
   * This is required for the perpetual markets to be tradeable.
   */
  private static async ensurePerpMarketSnapshots(): Promise<number> {
    let created = 0;
    let repaired = 0;

    // Get all organizations with tickers (these are tradeable as perps)
    const staticOrgs = StaticDataRegistry.getAllOrganizations();
    const tradeableOrgs = staticOrgs.filter((o) => o.ticker);

    // Get existing perp market snapshots
    const existingSnapshots = await db
      .select({
        ticker: perpMarketSnapshots.ticker,
        currentPrice: perpMarketSnapshots.currentPrice,
        price24hAgo: perpMarketSnapshots.price24hAgo,
        high24h: perpMarketSnapshots.high24h,
        low24h: perpMarketSnapshots.low24h,
        bidPrice: perpMarketSnapshots.bidPrice,
        askPrice: perpMarketSnapshots.askPrice,
        spreadBps: perpMarketSnapshots.spreadBps,
        bidDepth: perpMarketSnapshots.bidDepth,
        askDepth: perpMarketSnapshots.askDepth,
        markPrice: perpMarketSnapshots.markPrice,
        indexPrice: perpMarketSnapshots.indexPrice,
      })
      .from(perpMarketSnapshots);
    const existingByTicker = new Map(
      existingSnapshots.map((snapshot) => [snapshot.ticker, snapshot])
    );

    // Get organization states for current prices
    const orgStates = await db
      .select({
        id: organizationState.id,
        currentPrice: organizationState.currentPrice,
        basePrice: organizationState.basePrice,
      })
      .from(organizationState);
    const stateByOrgId = new Map(orgStates.map((state) => [state.id, state]));

    const now = new Date();
    const nextFundingTime = new Date(
      now.getTime() + FUNDING_INTERVAL_MS
    ).toISOString();

    for (const org of tradeableOrgs) {
      if (!org.ticker) {
        continue;
      }

      const state = stateByOrgId.get(org.id);
      const currentPrice =
        this.getFirstPositivePrice(
          state?.currentPrice,
          state?.basePrice,
          org.initialPrice
        ) ?? (await this.resolveCanonicalOrganizationSeedPrice(org));
      const existingSnapshot = existingByTicker.get(org.ticker);
      const initialQuote = getSyntheticPerpQuoteState({
        ticker: org.ticker,
        organizationId: org.id,
        name: org.name,
        currentPrice,
        price24hAgo: currentPrice,
        change24h: 0,
        changePercent24h: 0,
        high24h: currentPrice,
        low24h: currentPrice,
        volume24h: 0,
        openInterest: 0,
        fundingRate: {
          ticker: org.ticker,
          rate: 0.01,
          nextFundingTime,
          predictedRate: 0.01,
        },
        maxLeverage: 100,
        minOrderSize: 10,
        markPrice: currentPrice,
        indexPrice: currentPrice,
      });

      if (!existingSnapshot) {
        await db.insert(perpMarketSnapshots).values({
          ticker: org.ticker,
          organizationId: org.id,
          name: org.name,
          currentPrice,
          price24hAgo: currentPrice,
          price24hAgoUpdatedAt: now,
          metrics24hResetAt: now,
          change24h: 0,
          changePercent24h: 0,
          high24h: currentPrice,
          low24h: currentPrice,
          volume24h: 0,
          openInterest: 0,
          fundingRate: {
            ticker: org.ticker,
            rate: 0.01, // 1% APR base
            nextFundingTime,
            predictedRate: 0.01,
          },
          maxLeverage: 100,
          minOrderSize: 10,
          bidPrice: initialQuote.bidPrice,
          askPrice: initialQuote.askPrice,
          spreadBps: initialQuote.spreadBps,
          bidDepth: initialQuote.bidDepth,
          askDepth: initialQuote.askDepth,
          liquidityRegime: initialQuote.liquidityRegime,
          quoteUpdatedAt: now,
          markPrice: currentPrice,
          indexPrice: currentPrice,
          createdAt: now,
          updatedAt: now,
        });

        created++;
        logger.debug(
          `Created perp market snapshot for ${org.ticker} (${org.name})`,
          { ticker: org.ticker, price: currentPrice },
          'GameBootstrapService'
        );
        continue;
      }

      const hasInvalidSnapshotPrice =
        !Number.isFinite(Number(existingSnapshot.currentPrice)) ||
        Number(existingSnapshot.currentPrice) <= 0;
      const hasInvalidQuoteState =
        !Number.isFinite(Number(existingSnapshot.bidPrice)) ||
        !Number.isFinite(Number(existingSnapshot.askPrice)) ||
        !Number.isFinite(Number(existingSnapshot.spreadBps)) ||
        !Number.isFinite(Number(existingSnapshot.bidDepth)) ||
        !Number.isFinite(Number(existingSnapshot.askDepth)) ||
        Number(existingSnapshot.bidPrice) <= 0 ||
        Number(existingSnapshot.askPrice) < Number(existingSnapshot.bidPrice) ||
        Number(existingSnapshot.bidDepth) <= 0 ||
        Number(existingSnapshot.askDepth) <= 0;
      const hasInvalidReferenceFields =
        !Number.isFinite(Number(existingSnapshot.price24hAgo)) ||
        Number(existingSnapshot.price24hAgo) <= 0 ||
        !Number.isFinite(Number(existingSnapshot.high24h)) ||
        Number(existingSnapshot.high24h) <= 0 ||
        !Number.isFinite(Number(existingSnapshot.low24h)) ||
        Number(existingSnapshot.low24h) <= 0 ||
        !Number.isFinite(Number(existingSnapshot.markPrice)) ||
        Number(existingSnapshot.markPrice) <= 0 ||
        !Number.isFinite(Number(existingSnapshot.indexPrice)) ||
        Number(existingSnapshot.indexPrice) <= 0;

      if (
        hasInvalidSnapshotPrice ||
        hasInvalidQuoteState ||
        hasInvalidReferenceFields
      ) {
        await db
          .update(perpMarketSnapshots)
          .set({
            currentPrice,
            price24hAgo: currentPrice,
            price24hAgoUpdatedAt: now,
            high24h: currentPrice,
            low24h: currentPrice,
            bidPrice: initialQuote.bidPrice,
            askPrice: initialQuote.askPrice,
            spreadBps: initialQuote.spreadBps,
            bidDepth: initialQuote.bidDepth,
            askDepth: initialQuote.askDepth,
            liquidityRegime: initialQuote.liquidityRegime,
            quoteUpdatedAt: now,
            markPrice: currentPrice,
            indexPrice: currentPrice,
            updatedAt: now,
          })
          .where(eq(perpMarketSnapshots.ticker, org.ticker));

        repaired++;
        logger.warn(
          `Repaired invalid perp market snapshot for ${org.ticker}`,
          { ticker: org.ticker, organizationId: org.id, currentPrice },
          'GameBootstrapService'
        );
      }
    }

    if (created > 0) {
      logger.info(
        `Created ${created} perp market snapshots`,
        { created },
        'GameBootstrapService'
      );
    }

    if (repaired > 0) {
      logger.info(
        `Repaired ${repaired} invalid perp market snapshots`,
        { repaired },
        'GameBootstrapService'
      );
    }

    return created;
  }

  static getMinimumBalance(tier: string): number {
    return MINIMUM_BALANCE_BY_TIER[tier] || DEFAULT_MINIMUM_BALANCE;
  }

  static async getStats(): Promise<{
    actors: number;
    organizations: number;
    pools: number;
    characterMappings: number;
    organizationMappings: number;
    rssFeedSources: number;
    perpMarkets: number;
  }> {
    const [actorCount, orgCount, poolCount, feedCount, perpMarketCount] =
      await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(actorState),
        db.select({ count: sql<number>`count(*)` }).from(organizationState),
        db.select({ count: sql<number>`count(*)` }).from(pools),
        db.select({ count: sql<number>`count(*)` }).from(rssFeedSources),
        db.select({ count: sql<number>`count(*)` }).from(perpMarketSnapshots),
      ]);

    return {
      actors: Number(actorCount[0]?.count ?? 0),
      organizations: Number(orgCount[0]?.count ?? 0),
      pools: Number(poolCount[0]?.count ?? 0),
      characterMappings: StaticDataRegistry.getAllCharacterMappings().length,
      organizationMappings:
        StaticDataRegistry.getAllOrganizationMappings().length,
      rssFeedSources: Number(feedCount[0]?.count ?? 0),
      perpMarkets: Number(perpMarketCount[0]?.count ?? 0),
    };
  }
}

// Export convenience function for game tick
export async function bootstrapGameIfNeeded(): Promise<GameBootstrapResult | null> {
  return GameBootstrapService.bootstrapIfNeeded();
}
