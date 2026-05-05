/**
 * Bridge system that wraps executeGameTick() as a BabylonSystem.
 * Enables running the existing game tick within the runtime engine.
 *
 * Uses skipDeadlineCheck so the runtime never skips it —
 * executeGameTick() manages its own internal deadline.
 */

import { type ExecuteGameTickResult, executeGameTick } from '@babylon/engine';
import { defineSystem } from '../system';
import { TickPhase } from '../types';

export interface LegacyBridgeOptions {
  skipContentGeneration?: boolean;
  /** Subsystem IDs to skip — these are handled by new sim systems. */
  skip?: string[];
}

export function createLegacyGameTickSystem(options: LegacyBridgeOptions = {}) {
  const skipSet = new Set(options.skip ?? []);

  return defineSystem({
    id: 'legacy-game-tick',
    name: 'Legacy Game Tick',
    phase: TickPhase.Bootstrap,
    skipDeadlineCheck: true,

    async onTick() {
      const r: ExecuteGameTickResult = await executeGameTick(
        options.skipContentGeneration ?? false,
        skipSet
      );

      const metrics: Record<string, number | string | boolean> = {
        postsCreated: r.postsCreated,
        eventsCreated: r.eventsCreated,
        articlesCreated: r.articlesCreated,
        marketsUpdated: r.marketsUpdated,
        questionsResolved: r.questionsResolved,
        questionsCreated: r.questionsCreated,
        widgetCachesUpdated: r.widgetCachesUpdated,
        trendingCalculated: r.trendingCalculated,
        reputationSynced: r.reputationSynced,
        alphaInvitesSent: r.alphaInvitesSent,
      };

      // Optional top-level scalars
      if (r.npcSocialActionsProcessed !== undefined)
        metrics.npcSocialActionsProcessed = r.npcSocialActionsProcessed;
      if (r.npcLikesCreated !== undefined)
        metrics.npcLikesCreated = r.npcLikesCreated;
      if (r.npcSharesCreated !== undefined)
        metrics.npcSharesCreated = r.npcSharesCreated;
      if (r.npcCommentsCreated !== undefined)
        metrics.npcCommentsCreated = r.npcCommentsCreated;
      if (r.npcFollowsCreated !== undefined)
        metrics.npcFollowsCreated = r.npcFollowsCreated;
      if (r.npcUnfollows !== undefined) metrics.npcUnfollows = r.npcUnfollows;
      if (r.npcRebalanceActionsExecuted !== undefined)
        metrics.npcRebalanceActionsExecuted = r.npcRebalanceActionsExecuted;
      if (r.discourseReplies !== undefined)
        metrics.discourseReplies = r.discourseReplies;
      if (r.relationshipsUpdated !== undefined)
        metrics.relationshipsUpdated = r.relationshipsUpdated;
      if (r.priceVolatilitySimulated !== undefined)
        metrics.priceVolatilitySimulated = r.priceVolatilitySimulated;
      if (r.worldFactsUpdated !== undefined)
        metrics.worldFactsUpdated = r.worldFactsUpdated;

      // Flatten nested: reputationSyncStats
      if (r.reputationSyncStats) {
        metrics['reputationSyncStats.total'] = r.reputationSyncStats.total;
        metrics['reputationSyncStats.successful'] =
          r.reputationSyncStats.successful;
        metrics['reputationSyncStats.failed'] = r.reputationSyncStats.failed;
      }

      // Flatten nested: npcGroupDynamics
      if (r.npcGroupDynamics) {
        metrics['npcGroupDynamics.groupsCreated'] =
          r.npcGroupDynamics.groupsCreated;
        metrics['npcGroupDynamics.membersAdded'] =
          r.npcGroupDynamics.membersAdded;
        metrics['npcGroupDynamics.membersRemoved'] =
          r.npcGroupDynamics.membersRemoved;
        metrics['npcGroupDynamics.usersInvited'] =
          r.npcGroupDynamics.usersInvited;
        metrics['npcGroupDynamics.usersAutoJoined'] =
          r.npcGroupDynamics.usersAutoJoined;
        metrics['npcGroupDynamics.usersKicked'] =
          r.npcGroupDynamics.usersKicked;
        metrics['npcGroupDynamics.messagesPosted'] =
          r.npcGroupDynamics.messagesPosted;
      }

      // Flatten nested: narrativeArcs
      if (r.narrativeArcs) {
        metrics['narrativeArcs.arcsProcessed'] = r.narrativeArcs.arcsProcessed;
        metrics['narrativeArcs.transitioned'] = r.narrativeArcs.transitioned;
        metrics['narrativeArcs.eventsGenerated'] =
          r.narrativeArcs.eventsGenerated;
      }

      // Flatten nested: worldFactsStats
      if (r.worldFactsStats) {
        metrics['worldFactsStats.feedsFetched'] =
          r.worldFactsStats.feedsFetched;
        metrics['worldFactsStats.newHeadlines'] =
          r.worldFactsStats.newHeadlines;
        metrics['worldFactsStats.parodiesGenerated'] =
          r.worldFactsStats.parodiesGenerated;
        metrics['worldFactsStats.headlinesCleaned'] =
          r.worldFactsStats.headlinesCleaned;
        metrics['worldFactsStats.worldFactsGenerated'] =
          r.worldFactsStats.worldFactsGenerated;
        metrics['worldFactsStats.worldFactsArchived'] =
          r.worldFactsStats.worldFactsArchived;
      }

      // Flatten nested: timeframedMarkets (scalar fields only)
      if (r.timeframedMarkets) {
        metrics['timeframedMarkets.marketsProcessed'] =
          r.timeframedMarkets.marketsProcessed;
        metrics['timeframedMarkets.transitionsOccurred'] =
          r.timeframedMarkets.transitionsOccurred;
        metrics['timeframedMarkets.eventsGenerated'] =
          r.timeframedMarkets.eventsGenerated;
      }

      // Flatten nested: tokenStats
      if (r.tokenStats) {
        metrics['tokenStats.totalCalls'] = r.tokenStats.totalCalls;
        metrics['tokenStats.totalInputTokens'] = r.tokenStats.totalInputTokens;
        metrics['tokenStats.totalOutputTokens'] =
          r.tokenStats.totalOutputTokens;
        metrics['tokenStats.totalTokens'] = r.tokenStats.totalTokens;
        if (r.tokenStats.estimatedCostUSD !== undefined) {
          metrics['tokenStats.estimatedCostUSD'] =
            r.tokenStats.estimatedCostUSD;
        }
      }

      return {
        metrics,
        sharedData: { gameTickResult: r },
      };
    },
  });
}
