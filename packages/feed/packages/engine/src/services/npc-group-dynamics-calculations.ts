/**
 * NPC Group Dynamics Calculations
 *
 * Pure calculation functions for group chat dynamics, extracted from
 * NPCGroupDynamicsService for use in unit tests and other contexts
 * without database dependencies.
 */

export interface KickThresholds {
  idealMin: number; // Minimum messages for good standing
  idealMax: number; // Maximum before considered over-posting
  spamThreshold: number; // Immediate kick threshold
  fairShare: number; // Expected share if everyone contributed equally
}

export interface KickProbabilityResult {
  probability: number;
  reason: string;
  category: "inactive" | "low" | "over" | "spam" | "safe";
}

/**
 * Calculate dynamic thresholds based on group activity.
 *
 * Returns participation thresholds relative to group's average activity level.
 * This ensures users aren't penalized in low-activity groups or get away with
 * minimal contribution in high-activity groups.
 */
function calculateDynamicThresholds(
  totalMessages: number,
  participantCount: number,
  windowDays = 7,
): KickThresholds {
  // Fair share = total messages / participants (what each would have if equal)
  const fairShare = participantCount > 0 ? totalMessages / participantCount : 0;

  // Ideal participation: between 50% and 150% of fair share
  // But with minimum floors to handle low-activity groups
  const idealMin = Math.max(1, Math.floor(fairShare * 0.5));
  const idealMax = Math.max(5, Math.ceil(fairShare * 1.5));

  // Spam threshold: more than 3x fair share OR more than 20 messages/day
  // The higher of these two catches both relative and absolute spammers
  const maxMessagesPerDay = 20;
  const absoluteSpamThreshold = maxMessagesPerDay * windowDays;
  const relativeSpamThreshold = Math.max(10, Math.ceil(fairShare * 3));
  const spamThreshold = Math.min(absoluteSpamThreshold, relativeSpamThreshold);

  return { idealMin, idealMax, spamThreshold, fairShare };
}

/**
 * NPCGroupDynamicsCalculations
 *
 * Static class containing pure calculation methods for group dynamics.
 * Separate from NPCGroupDynamicsService to allow testing without database dependencies.
 */
export class NPCGroupDynamicsCalculations {
  /**
   * Calculate kick probability with exponential scaling for over-posting
   *
   * The probability increases exponentially as the user's message count
   * exceeds the ideal max, reaching near-certainty at spam threshold.
   *
   * @param userMessageCount - Number of messages the user has sent
   * @param totalMessages - Total messages in the group
   * @param participantCount - Number of participants in the group
   * @param windowDays - Number of days in the window (default 7)
   * @returns { probability: number, reason: string, category: 'inactive' | 'low' | 'over' | 'spam' | 'safe' }
   */
  static calculateKickProbability(
    userMessageCount: number,
    totalMessages: number,
    participantCount: number,
    windowDays = 7,
  ): KickProbabilityResult {
    const thresholds = calculateDynamicThresholds(
      totalMessages,
      participantCount,
      windowDays,
    );

    // Case 1: Never posted - high kick chance (inactive)
    if (userMessageCount === 0) {
      return {
        probability: 0.9,
        reason: "Never participated in conversation",
        category: "inactive",
      };
    }

    // Case 2: Spam behavior - immediate kick (exponentially approaching 1.0)
    if (userMessageCount >= thresholds.spamThreshold) {
      // At spam threshold: 95% chance, increases toward 100% for extreme cases
      const excessRatio = userMessageCount / thresholds.spamThreshold;
      const spamProbability = 0.95 + 0.05 * (1 - Math.exp(-excessRatio + 1));
      return {
        probability: Math.min(0.99, spamProbability),
        reason: `Spamming: ${userMessageCount} messages (threshold: ${thresholds.spamThreshold})`,
        category: "spam",
      };
    }

    // Case 3: Over-posting (between idealMax and spamThreshold)
    // Use exponential increase: probability grows faster as you approach spam threshold
    if (userMessageCount > thresholds.idealMax) {
      const excessMessages = userMessageCount - thresholds.idealMax;
      const range = thresholds.spamThreshold - thresholds.idealMax;
      const normalizedExcess = range > 0 ? excessMessages / range : 0;

      // Exponential curve: starts at ~0.1 for just over max, approaches 0.9 near spam threshold
      // Formula: 0.1 + 0.8 * (1 - e^(-3x)) where x is normalized excess (0 to 1)
      const kickProbability = 0.1 + 0.8 * (1 - Math.exp(-3 * normalizedExcess));

      const userRatio =
        totalMessages > 0 ? (userMessageCount / totalMessages) * 100 : 0;
      return {
        probability: kickProbability,
        reason: `Over-posting: ${userMessageCount} messages (${userRatio.toFixed(0)}% of total, ideal max: ${thresholds.idealMax})`,
        category: "over",
      };
    }

    // Case 4: Low participation (only if group has meaningful activity)
    if (userMessageCount < thresholds.idealMin && totalMessages > 20) {
      // Linear scale from 0.2 (just under minimum) to 0.5 (at 1 message)
      const ratio =
        thresholds.idealMin > 1
          ? (userMessageCount - 1) / (thresholds.idealMin - 1)
          : 0;
      const lowProbability = 0.5 - 0.3 * ratio;

      return {
        probability: Math.max(0.2, lowProbability),
        reason: `Low participation: ${userMessageCount} messages (minimum ideal: ${thresholds.idealMin})`,
        category: "low",
      };
    }

    // Case 5: Good participation - safe zone!
    return {
      probability: 0,
      reason: "", // No reason needed for safe category
      category: "safe",
    };
  }
}
