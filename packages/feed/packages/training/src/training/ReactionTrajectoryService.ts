/**
 * Reaction Trajectory Service
 *
 * Records event-reaction-outcome chains for RL training.
 * Tracks which reactions led to engagement/market impact.
 *
 * Flow:
 * 1. NPC encounters event -> recordReactionStart()
 * 2. 1-24 hours later -> recordReactionOutcome()
 * 3. Export for training with calculated rewards
 */

import {
  and,
  db,
  eq,
  gte,
  isNull,
  lte,
  reactionTrajectories,
} from '@babylon/db';
import { generateSnowflakeId, logger } from '@babylon/shared';

export interface ReactionDecision {
  eventId: string;
  eventType: string;
  eventSeverity: number;
  npcId: string;
  npcRole: 'insider' | 'affiliated' | 'observer';
  arcPhase: string | null;
  orgCoordinationContext: {
    orgMatesReacted: number;
    availableAngles: string[];
  } | null;
}

export interface ReactionAction {
  actionType: 'post' | 'comment' | 'trade' | 'none';
  angle: string | null;
  sentiment: string | null;
  postId: string | null;
  tradeDetails: {
    ticker: string;
    direction: 'buy' | 'sell';
    amount: number;
  } | null;
}

export interface ReactionOutcome {
  // Engagement metrics (measured 1-24h later)
  likes: number;
  comments: number;
  reposts: number;

  // Market impact (if trade)
  priceMovement: number | null;
  profitLoss: number | null;

  // Narrative impact
  otherNpcsReacted: number;
  humanReactions: number;
}

export class ReactionTrajectoryService {
  /**
   * Record the initial reaction decision.
   * Called when NPC is about to react to an event.
   */
  async recordReactionStart(
    decision: ReactionDecision,
    action: ReactionAction
  ): Promise<string> {
    const id = await generateSnowflakeId();
    const now = new Date();

    try {
      await db.insert(reactionTrajectories).values({
        id,
        eventId: decision.eventId,
        eventType: decision.eventType,
        eventSeverity: decision.eventSeverity,
        npcId: decision.npcId,
        npcRole: decision.npcRole,
        arcPhase: decision.arcPhase,
        orgContextJson: decision.orgCoordinationContext
          ? JSON.stringify(decision.orgCoordinationContext)
          : null,
        actionType: action.actionType,
        actionAngle: action.angle,
        actionSentiment: action.sentiment,
        postId: action.postId,
        tradeDetailsJson: action.tradeDetails
          ? JSON.stringify(action.tradeDetails)
          : null,
        createdAt: now,
      });

      logger.debug(
        'Recorded reaction start',
        {
          trajectoryId: id,
          eventId: decision.eventId,
          action: action.actionType,
        },
        'ReactionTrajectoryService'
      );

      return id;
    } catch (error) {
      logger.warn(
        'Failed to record reaction start',
        {
          eventId: decision.eventId,
          error: error instanceof Error ? error.message : String(error),
        },
        'ReactionTrajectoryService'
      );
      throw error;
    }
  }

  /**
   * Record outcomes for a reaction (called 1-24h later).
   */
  async recordReactionOutcome(
    trajectoryId: string,
    outcome: ReactionOutcome
  ): Promise<void> {
    const reward = this.calculateRewardFromOutcome(outcome);

    await db
      .update(reactionTrajectories)
      .set({
        outcomeRecordedAt: new Date(),
        outcomeLikes: outcome.likes,
        outcomeComments: outcome.comments,
        outcomeReposts: outcome.reposts,
        outcomePriceMovement: outcome.priceMovement?.toString() ?? null,
        outcomeProfitLoss: outcome.profitLoss?.toString() ?? null,
        outcomeOtherNpcs: outcome.otherNpcsReacted,
        outcomeHumans: outcome.humanReactions,
        reward: reward.toString(),
      })
      .where(eq(reactionTrajectories.id, trajectoryId));

    logger.debug(
      'Recorded reaction outcome',
      { trajectoryId, reward },
      'ReactionTrajectoryService'
    );
  }

  /**
   * Get pending trajectories that need outcome measurement.
   * Returns trajectories created 1-24h ago without outcomes.
   */
  async getPendingOutcomeMeasurements(
    limit: number = 100
  ): Promise<{ id: string; postId: string | null }[]> {
    const now = Date.now();
    const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);

    const pending = await db
      .select({
        id: reactionTrajectories.id,
        postId: reactionTrajectories.postId,
      })
      .from(reactionTrajectories)
      .where(
        and(
          gte(reactionTrajectories.createdAt, twentyFourHoursAgo),
          lte(reactionTrajectories.createdAt, oneHourAgo),
          isNull(reactionTrajectories.outcomeRecordedAt)
        )
      )
      .limit(limit);

    return pending;
  }

  /**
   * Calculate reward from outcome metrics.
   */
  private calculateRewardFromOutcome(outcome: ReactionOutcome): number {
    let reward = 0;

    // Engagement reward (normalized using log for diminishing returns)
    reward += Math.log1p(outcome.likes) * 0.1;
    reward += Math.log1p(outcome.comments) * 0.2;
    reward += Math.log1p(outcome.reposts) * 0.15;

    // Human reactions are especially valuable
    reward += Math.log1p(outcome.humanReactions) * 0.3;

    // Trading reward (if applicable)
    if (outcome.profitLoss !== null) {
      reward += Math.tanh(outcome.profitLoss / 100) * 0.5;
    }

    // NPC reactions indicate relevance
    reward += Math.log1p(outcome.otherNpcsReacted) * 0.1;

    return reward;
  }

  /**
   * Calculate reward for a reaction (for RL training).
   * This version takes the full decision context into account.
   */
  calculateReward(
    outcome: ReactionOutcome,
    decision: ReactionDecision
  ): number {
    let reward = this.calculateRewardFromOutcome(outcome);

    // Role-appropriate bonus
    if (decision.npcRole === 'insider' && outcome.otherNpcsReacted > 0) {
      reward += 0.2; // Insiders should spark conversation
    }

    // Penalty for over-saturation (too many org-mates already reacted)
    if (
      decision.orgCoordinationContext?.orgMatesReacted &&
      decision.orgCoordinationContext.orgMatesReacted >= 3
    ) {
      reward -= 0.3; // Shouldn't pile on
    }

    // Bonus for high-severity events
    if (decision.eventSeverity >= 4) {
      reward *= 1.2; // Reactions to important events matter more
    }

    return reward;
  }

  /**
   * Get trajectories ready for training export.
   */
  async getTrainingReadyTrajectories(
    limit: number = 500
  ): Promise<(typeof reactionTrajectories.$inferSelect)[]> {
    return db
      .select()
      .from(reactionTrajectories)
      .where(
        and(
          eq(reactionTrajectories.usedInTraining, false),
          // Has outcome recorded
          gte(reactionTrajectories.outcomeRecordedAt, new Date(0))
        )
      )
      .limit(limit);
  }

  /**
   * Mark trajectories as used in training.
   */
  async markAsUsedInTraining(trajectoryIds: string[]): Promise<void> {
    if (trajectoryIds.length === 0) return;

    for (const id of trajectoryIds) {
      await db
        .update(reactionTrajectories)
        .set({ usedInTraining: true })
        .where(eq(reactionTrajectories.id, id));
    }
  }
}

export const reactionTrajectoryService = new ReactionTrajectoryService();
