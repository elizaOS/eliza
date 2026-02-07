/**
 * Calculate relationship strength based on interaction patterns
 *
 * @param {Object} params - Parameters for calculating relationship strength
 * @param {number} params.interactionCount - Total number of interactions
 * @param {string} params.lastInteractionAt - ISO timestamp of last interaction
 * @param {number} params.messageQuality - Average quality score of messages (0-10)
 * @param {string} params.relationshipType - Type of relationship
 * @returns {number} Relationship strength score (0-100)
 */
export function calculateRelationshipStrength({
  interactionCount,
  lastInteractionAt,
  messageQuality = 5,
  relationshipType = 'acquaintance',
}: {
  interactionCount: number;
  lastInteractionAt?: string;
  messageQuality?: number;
  relationshipType?: string;
}): number {
  // Base score from interaction count (max 40 points)
  const interactionScore = Math.min(interactionCount * 2, 40);

  // Recency score (max 30 points)
  let recencyScore = 0;
  if (lastInteractionAt) {
    const daysSinceLastInteraction =
      (Date.now() - new Date(lastInteractionAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLastInteraction < 1) recencyScore = 30;
    else if (daysSinceLastInteraction < 7) recencyScore = 25;
    else if (daysSinceLastInteraction < 30) recencyScore = 20;
    else if (daysSinceLastInteraction < 90) recencyScore = 10;
    else recencyScore = 5;
  }

  // Quality score (max 20 points)
  const qualityScore = (messageQuality / 10) * 20;

  // Relationship type bonus (max 10 points)
  const relationshipBonus =
    {
      family: 10,
      friend: 8,
      colleague: 6,
      acquaintance: 4,
      unknown: 0,
    }[relationshipType] || 0;

  // Calculate total strength
  const totalStrength = interactionScore + recencyScore + qualityScore + relationshipBonus;

  // Return clamped value between 0 and 100
  return Math.max(0, Math.min(100, Math.round(totalStrength)));
}
