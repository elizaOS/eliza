import { type Provider, composePrompt } from '@elizaos/core';
import { formatRecommendations } from '../recommendations/evaluator';

const recommendationsPrompt = `<user_recommendations_provider>
<draft_recommendations>{{recommendations}}</draft_recommendations>
</user_recommendations_provider>` as const;

/**
 * Provider for retrieving recommendations based on user input.
 * @type {Provider}
 */
export const recommendationsProvider: Provider = {
  name: 'recommendations',
  async get(runtime, message) {
    const recentRecommendations = await runtime.getMemories({
      tableName: 'recommendations',
      roomId: message.roomId,
      count: 5,
    });

    const newUserRecommendation = recentRecommendations.filter(
      (m) =>
        m.entityId === message.entityId && (m.metadata as any).recommendation.confirmed !== true
    );

    if (newUserRecommendation.length === 0) {
      return {
        data: {
          recommendations: [],
        },
        values: {
          hasRecommendations: 'false',
        },
        text: '',
      };
    }

    const formattedRecommendations = formatRecommendations(newUserRecommendation);
    const renderedText = composePrompt({
      template: recommendationsPrompt,
      state: {
        recommendations: formattedRecommendations,
      },
    });

    return {
      data: {
        recommendations: newUserRecommendation,
        formattedRecommendations,
      },
      values: {
        hasRecommendations: 'true',
        count: newUserRecommendation.length.toString(),
      },
      text: renderedText,
    };
  },
};
