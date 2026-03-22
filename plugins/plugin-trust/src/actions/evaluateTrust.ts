import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type UUID,
  logger,
  type ActionExample,
  parseJSONObjectFromText,
} from '@elizaos/core';
import type { TrustProfile } from '../types/trust';

export const evaluateTrustAction: Action = {
  name: 'EVALUATE_TRUST',
  description: 'Evaluates the trust score and profile for a specified entity',

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const trustEngine = runtime.getService('trust-engine');
    return !!trustEngine;
  },

  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const trustEngine = runtime.getService('trust-engine') as any;

    if (!trustEngine) {
      throw new Error('Trust engine service not available');
    }

    // Parse the request (plain text like "What is my trust score?" => evaluate sender)
    const text = message.content.text || '';
    let requestData: {
      entityId?: string;
      entityName?: string;
      detailed?: boolean;
    } | null = null;
    try {
      const parsed = parseJSONObjectFromText(text);
      requestData = parsed as typeof requestData;
    } catch {
      // Non-JSON input: default to evaluating the message sender
    }

    // Try to extract entity from message if not in parsed data
    let targetEntityId: UUID | undefined;
    if (requestData?.entityId) {
      targetEntityId = requestData.entityId as UUID;
    } else if (requestData?.entityName) {
      // TODO: Resolve entity name to ID using rolodex or other service
      return {
        success: false,
        text: 'Entity name resolution not yet implemented. Please provide entity ID.',
        error: true,
      };
    } else {
      // Default to evaluating the message sender
      targetEntityId = message.entityId;
    }

    try {
      const trustContext = {
        evaluatorId: runtime.agentId,
        roomId: message.roomId,
      };

      const trustProfile: TrustProfile = await trustEngine.evaluateTrust(
        targetEntityId,
        runtime.agentId,
        trustContext
      );

      // Format response based on detail level
      const detailed = requestData?.detailed ?? false;

      if (detailed) {
        const dimensionText = Object.entries(trustProfile.dimensions)
          .map(([dim, score]) => `- ${dim}: ${score}/100`)
          .join('\n');

        const trendText =
          trustProfile.trend.direction === 'increasing'
            ? `📈 Increasing (+${trustProfile.trend.changeRate.toFixed(1)} pts/day)`
            : trustProfile.trend.direction === 'decreasing'
              ? `📉 Decreasing (${trustProfile.trend.changeRate.toFixed(1)} pts/day)`
              : '➡️ Stable';

        return {
          success: true,
          text: `Trust Profile for ${targetEntityId}:

Overall Trust: ${trustProfile.overallTrust}/100
Confidence: ${(trustProfile.confidence * 100).toFixed(0)}%
Interactions: ${trustProfile.interactionCount}
Trend: ${trendText}

Trust Dimensions:
${dimensionText}

Last Updated: ${new Date(trustProfile.lastCalculated).toLocaleString()}`,
          data: trustProfile,
        };
      } else {
        const trustLevel =
          trustProfile.overallTrust >= 80
            ? 'High'
            : trustProfile.overallTrust >= 60
              ? 'Good'
              : trustProfile.overallTrust >= 40
                ? 'Moderate'
                : trustProfile.overallTrust >= 20
                  ? 'Low'
                  : 'Very Low';

        return {
          success: true,
          text: `Trust Level: ${trustLevel} (${trustProfile.overallTrust}/100) based on ${trustProfile.interactionCount} interactions`,
          data: {
            trustScore: trustProfile.overallTrust,
            trustLevel,
            confidence: trustProfile.confidence,
          },
        };
      }
    } catch (error) {
      logger.error({ error }, '[EvaluateTrust] Error evaluating trust:');
      return {
        success: false,
        text: 'Failed to evaluate trust. Please try again.',
        error: true,
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'What is my trust score?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Trust Level: Good (65/100) based on 42 interactions',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Show detailed trust profile for Alice',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: `Trust Profile for Alice:

Overall Trust: 78/100
Confidence: 85%
Interactions: 127
Trend: 📈 Increasing (+0.5 pts/day)

Trust Dimensions:
- reliability: 82/100
- competence: 75/100
- integrity: 80/100
- benevolence: 85/100
- transparency: 70/100

Last Updated: 12/20/2024, 3:45:00 PM`,
        },
      },
    ],
  ],

  similes: [
    'check trust score',
    'evaluate trust',
    'show trust level',
    'trust rating',
    'trust profile',
    'trust assessment',
    'check reputation',
    'show trust details',
  ],
};
