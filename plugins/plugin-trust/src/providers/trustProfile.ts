import { type Provider, type IAgentRuntime, type Memory, type State, logger } from '@elizaos/core';

export const trustProfileProvider: Provider = {
  name: 'trustProfile',
  description: 'Provides trust profile information for entities in the current context',

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      // returns the wrapper not the engine itself
      const trustEngine = runtime.getService('trust-engine') as any;

      if (!trustEngine) {
        return {
          text: 'Trust engine not available',
          values: {},
        };
      }
      if (!trustEngine.trustEngine.evaluateTrust) {
        return {
          text: 'Trust engine evaluateTrust not available',
          values: {},
        };
      }

      // Get trust profile for the message sender
      const senderProfile = await trustEngine.trustEngine.evaluateTrust(message.entityId, runtime.agentId, {
        roomId: message.roomId,
      });

      // Get recent trust changes
      const recentInteractions = await trustEngine.getRecentInteractions(
        message.entityId,
        7 // Last 7 days
      );

      // Format trust information
      const trustLevel =
        senderProfile.overallTrust >= 80
          ? 'high trust'
          : senderProfile.overallTrust >= 60
            ? 'good trust'
            : senderProfile.overallTrust >= 40
              ? 'moderate trust'
              : senderProfile.overallTrust >= 20
                ? 'low trust'
                : 'very low trust';

      const trendText =
        senderProfile.trend.direction === 'increasing'
          ? 'improving'
          : senderProfile.trend.direction === 'decreasing'
            ? 'declining'
            : 'stable';

      return {
        text: `The user has ${trustLevel} (${senderProfile.overallTrust}/100) with ${trendText} trust trend based on ${senderProfile.interactionCount} interactions.`,
        values: {
          trustScore: senderProfile.overallTrust,
          trustLevel,
          trustTrend: senderProfile.trend.direction,
          reliability: senderProfile.dimensions.reliability,
          competence: senderProfile.dimensions.competence,
          integrity: senderProfile.dimensions.integrity,
          benevolence: senderProfile.dimensions.benevolence,
          transparency: senderProfile.dimensions.transparency,
          interactionCount: senderProfile.interactionCount,
          recentPositiveActions: recentInteractions.filter((i: any) => i.impact > 0).length,
          recentNegativeActions: recentInteractions.filter((i: any) => i.impact < 0).length,
        },
        data: {
          profile: senderProfile,
          recentInteractions,
        },
      };
    } catch (error) {
      console.error('error', error)
      logger.error({ error }, '[TrustProfileProvider] Error fetching trust profile:');
      return {
        text: 'Unable to fetch trust profile',
        values: {},
      };
    }
  },
};
