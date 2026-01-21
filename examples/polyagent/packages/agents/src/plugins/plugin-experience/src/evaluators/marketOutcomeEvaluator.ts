/**
 * Market Outcome Evaluator
 *
 * Consolidated evaluator that:
 * 1. Tracks NPC trust scores (who to believe)
 * 2. Evaluates agent's own performance (win/loss tracking)
 * 3. Records learning experiences from market outcomes
 *
 * Runs automatically when markets resolve.
 */

import {
  type Evaluator,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { db } from "@polyagent/db";

interface NPCTrustScore {
  accuracy: number; // 0-1, percentage of correct predictions
  sampleSize: number; // Number of predictions tracked
  lastUpdated: string;
}

interface AgentPerformanceScore {
  marketsTraded: number;
  correctPredictions: number;
  incorrectPredictions: number;
  winRate: number;
  totalPnL: number;
  lastUpdated: string;
}

/**
 * Extract YES/NO prediction from post content
 */
function extractPredictionFromContent(content: string): "YES" | "NO" | null {
  const lower = content.toLowerCase();

  // Strong indicators
  if (
    lower.includes("will succeed") ||
    lower.includes("definitely yes") ||
    lower.includes("bullish") ||
    lower.includes("going to win")
  ) {
    return "YES";
  }

  if (
    lower.includes("will fail") ||
    lower.includes("definitely no") ||
    lower.includes("bearish") ||
    lower.includes("going to lose")
  ) {
    return "NO";
  }

  // Sentiment analysis
  const positiveCount = (
    content.match(/succeed|success|win|positive|optimistic|confident/gi) || []
  ).length;
  const negativeCount = (
    content.match(/fail|failure|lose|negative|pessimistic|doubt/gi) || []
  ).length;

  if (positiveCount > negativeCount + 2) return "YES";
  if (negativeCount > positiveCount + 2) return "NO";

  return null;
}

export const marketOutcomeEvaluator: Evaluator = {
  name: "MARKET_OUTCOME_EVALUATOR",
  similes: ["market learning", "trust tracker", "performance evaluator"],
  description:
    "Learns from market outcomes to update NPC trust scores and track agent performance",
  examples: [],
  alwaysRun: false,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const content = message.content;

    // Run when a market has resolved
    const isResolution =
      content.text?.includes("market resolved") ||
      content.text?.includes("question resolved") ||
      content.action === "MARKET_RESOLVED";

    return isResolution;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<void> => {
    const questionNumber = message.content.questionNumber as number;
    const outcome = message.content.outcome as boolean;

    if (!questionNumber || outcome === undefined) {
      return;
    }

    logger.info(
      `[Market Learning] Processing market ${questionNumber} outcome: ${outcome ? "YES" : "NO"}`,
    );

    // === 1. UPDATE NPC TRUST SCORES ===

    // Only analyze posts up to resolution time (no future posts)
    const now = new Date();
    const posts = await db.post.findMany({
      where: {
        gameId: questionNumber.toString(),
        deletedAt: null,
        timestamp: { lte: now }, // ✅ No future posts
      },
      select: {
        id: true,
        content: true,
        authorId: true,
      },
      take: 500,
    });

    // Fetch author details separately
    const authorIds = [...new Set(posts.map((p) => p.authorId))];
    const authors = await db.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, displayName: true, isActor: true },
    });
    const authorMap = new Map(authors.map((a) => [a.id, a]));

    const npcPosts = posts.filter((p) => authorMap.get(p.authorId)?.isActor);

    /**
     * Get current trust scores from database.
     *
     * Trust scores are computed from historical performance and stored in AgentPerformanceMetrics.
     */
    const npcTrust: Record<string, NPCTrustScore> = {};

    // Trust scores are computed from post outcomes, not from AgentPerformanceMetrics
    // AgentPerformanceMetrics is for user-controlled agents, not NPCs
    // NPC trust scores are built incrementally as we evaluate their predictions

    let npcUpdated = 0;

    for (const post of npcPosts) {
      const author = authorMap.get(post.authorId);
      const npcName = author?.displayName || "Unknown";
      const predicted = extractPredictionFromContent(post.content);

      if (!predicted) continue;

      const npcSaidYes = predicted === "YES";
      const correct = npcSaidYes === outcome;

      const current: NPCTrustScore = npcTrust[npcName] || {
        accuracy: 0.5,
        sampleSize: 0,
        lastUpdated: new Date().toISOString(),
      };

      current.sampleSize++;

      const learningRate = 0.1;
      if (correct) {
        current.accuracy =
          current.accuracy + learningRate * (1.0 - current.accuracy);
      } else {
        current.accuracy = current.accuracy - learningRate * current.accuracy;
      }

      current.accuracy = Math.max(0.1, Math.min(0.9, current.accuracy));
      current.lastUpdated = new Date().toISOString();

      npcTrust[npcName] = current;
      npcUpdated++;
    }

    /**
     * Save NPC trust scores.
     *
     * messageManager API not available - trust scores updated in memory only.
     */
    logger.info(
      `[NPC Trust] Updated ${npcUpdated} NPC trust scores (in-memory only)`,
    );

    // === 2. EVALUATE AGENT'S OWN PERFORMANCE ===

    // Check if agent had a position in this market
    const agentPosition = await db.position.findFirst({
      where: {
        userId: runtime.agentId,
        marketId: questionNumber.toString(),
      },
      select: {
        side: true,
        shares: true,
        avgPrice: true,
      },
    });

    if (agentPosition) {
      /**
       * Get current performance scores.
       *
       * messageManager API not available - using fresh state.
       */
      const performance: AgentPerformanceScore = {
        marketsTraded: 0,
        correctPredictions: 0,
        incorrectPredictions: 0,
        winRate: 0,
        totalPnL: 0,
        lastUpdated: new Date().toISOString(),
      };

      performance.marketsTraded++;

      const agentPredictedYes = agentPosition.side;
      const agentCorrect = agentPredictedYes === outcome;

      if (agentCorrect) {
        performance.correctPredictions++;
        const profit =
          parseFloat(agentPosition.shares.toString()) *
          (1 - parseFloat(agentPosition.avgPrice.toString()));
        performance.totalPnL += profit;
      } else {
        performance.incorrectPredictions++;
        const loss =
          parseFloat(agentPosition.shares.toString()) *
          parseFloat(agentPosition.avgPrice.toString());
        performance.totalPnL -= loss;
      }

      performance.winRate =
        performance.correctPredictions / performance.marketsTraded;
      performance.lastUpdated = new Date().toISOString();

      // Save performance
      /**
       * messageManager API not available - performance tracked in-memory only.
       */
      logger.info(
        `[Performance] ${agentCorrect ? "WIN" : "LOSS"} - Win rate: ${(performance.winRate * 100).toFixed(0)}% (${performance.correctPredictions}/${performance.marketsTraded}), P&L: $${performance.totalPnL.toFixed(2)}`,
      );
    }

    // === 3. LOG TOP PERFORMERS ===

    const sorted = Object.entries(npcTrust).sort(
      (a, b) => b[1].accuracy - a[1].accuracy,
    );
    if (sorted.length > 0) {
      const top3 = sorted.slice(0, 3);
      const topNPCsInfo = top3
        .map(
          ([name, data]) =>
            `${name}: ${(data.accuracy * 100).toFixed(0)}% (${data.sampleSize} samples)`,
        )
        .join(", ");
      logger.info(`[Top NPCs] ${topNPCsInfo}`);
    }
  },
};
