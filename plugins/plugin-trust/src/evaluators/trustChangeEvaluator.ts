import { type Evaluator, type IAgentRuntime, type Memory, type State, logger } from '@elizaos/core';
import { TrustEvidenceType } from '../types/trust';

export const trustChangeEvaluator: Evaluator = {
  name: 'trustChangeEvaluator',
  description: 'Evaluates interactions to detect and record trust-affecting behaviors',
  alwaysRun: true,

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    const trustEngine = runtime.getService('trust-engine');
    return !!trustEngine;
  },

  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const trustEngineWrapper = runtime.getService('trust-engine') as any;

    if (!trustEngineWrapper) {
      return;
    }
    const trustEngine = trustEngineWrapper.trustEngine

    try {
      const content = message.content.text?.toLowerCase() || '';
      const entityId = message.entityId;

      // Use LLM evaluator if available
      const llmEvaluator = runtime.getService('llm-evaluator');
      if (llmEvaluator) {
        // Analyze behavior using LLM
        const analysis = await (llmEvaluator as any).analyzeBehavior(
          [content],
          [],
          entityId
        );

        // Determine trust impact based on analysis
        if (analysis.riskScore < 0.3) {
          // Positive behavior
          await trustEngine.recordInteraction({
            sourceEntityId: entityId,
            targetEntityId: runtime.agentId,
            type: TrustEvidenceType.HELPFUL_ACTION,
            timestamp: Date.now(),
            impact: 10,
            details: {
              description: `Positive behavior detected via LLM analysis`,
              messageId: message.id,
              roomId: message.roomId,
              autoDetected: true,
              personality: analysis.personality,
            },
            context: {
              roomId: message.roomId,
            },
          });

          logger.info({
            entityId,
            personality: analysis.personality,
          }, '[TrustChangeEvaluator] LLM detected positive behavior:');

          return {
            success: true,
            text: `Noted positive behavior (+10 trust)`,
            data: { impact: 10, positive: true, llmAnalysis: true },
          };
        } else if (analysis.riskScore > 0.7) {
          // Negative behavior
          const impact = analysis.riskScore > 0.85 ? -25 : -15;
          await trustEngine.recordInteraction({
            sourceEntityId: entityId,
            targetEntityId: runtime.agentId,
            type: TrustEvidenceType.SUSPICIOUS_ACTIVITY,
            timestamp: Date.now(),
            impact,
            details: {
              description: `Suspicious behavior detected via LLM analysis`,
              messageId: message.id,
              roomId: message.roomId,
              autoDetected: true,
              anomalies: analysis.anomalies,
              riskScore: analysis.riskScore,
            },
            context: {
              roomId: message.roomId,
            },
          });

          logger.warn({
            entityId,
            riskScore: analysis.riskScore,
            anomalies: analysis.anomalies,
          }, '[TrustChangeEvaluator] LLM detected suspicious behavior:');

          return {
            success: false,
            text: `Noted concerning behavior (${impact} trust)`,
            data: { impact, positive: false, llmAnalysis: true },
          };
        }

        // Neutral behavior - no trust change
        return;
      }

      // Fallback to pattern matching only if LLM is not available
      // Define patterns for trust-affecting behaviors
      const positivePatterns = [
        {
          pattern: /thank you|thanks|appreciate|grateful/i,
          type: TrustEvidenceType.HELPFUL_ACTION,
          impact: 5,
        },
        {
          pattern: /helped|assisted|supported|solved/i,
          type: TrustEvidenceType.HELPFUL_ACTION,
          impact: 10,
        },
        {
          pattern: /kept.*promise|delivered|followed through/i,
          type: TrustEvidenceType.PROMISE_KEPT,
          impact: 15,
        },
        {
          pattern: /contributed|shared|provided/i,
          type: TrustEvidenceType.COMMUNITY_CONTRIBUTION,
          impact: 8,
        },
      ];

      const negativePatterns = [
        { pattern: /spam|flood|repeat/i, type: TrustEvidenceType.SPAM_BEHAVIOR, impact: -10 },
        {
          pattern: /broke.*promise|failed to|didn't deliver/i,
          type: TrustEvidenceType.PROMISE_BROKEN,
          impact: -15,
        },
        { pattern: /hack|exploit|cheat/i, type: TrustEvidenceType.SECURITY_VIOLATION, impact: -25 },
        { pattern: /harass|abuse|threat/i, type: TrustEvidenceType.HARMFUL_ACTION, impact: -20 },
      ];

      // Check for positive behaviors
      for (const { pattern, type, impact } of positivePatterns) {
        if (pattern.test(content)) {
          await trustEngine.recordInteraction({
            sourceEntityId: entityId,
            targetEntityId: runtime.agentId,
            type,
            timestamp: Date.now(),
            impact,
            details: {
              description: `Positive behavior detected: ${type}`,
              messageId: message.id,
              roomId: message.roomId,
              autoDetected: true,
            },
            context: {
              roomId: message.roomId,
            },
          });

          logger.info({
            entityId,
            type,
            impact,
          }, '[TrustChangeEvaluator] Recorded positive behavior:');

          return {
            success: true,
            text: `Noted positive behavior: ${type} (+${impact} trust)`,
            data: { type, impact, positive: true },
          };
        }
      }

      // Check for negative behaviors
      for (const { pattern, type, impact } of negativePatterns) {
        if (pattern.test(content)) {
          await trustEngine.recordInteraction({
            sourceEntityId: entityId,
            targetEntityId: runtime.agentId,
            type,
            timestamp: Date.now(),
            impact,
            details: {
              description: `Negative behavior detected: ${type}`,
              messageId: message.id,
              roomId: message.roomId,
              autoDetected: true,
            },
            context: {
              roomId: message.roomId,
            },
          });

          logger.warn({
            entityId,
            type,
            impact,
          }, '[TrustChangeEvaluator] Recorded negative behavior:');

          return {
            success: false,
            text: `Noted concerning behavior: ${type} (${impact} trust)`,
            data: { type, impact, positive: false },
          };
        }
      }

      // Check for message frequency (spam detection)
      // TODO: Implement proper message frequency check using components or another method
      // For now, skip this check
      /*
      const recentMessages = await runtime.store.getRecentMessages(entityId, 60000); // Last minute
      if (recentMessages.length > 10) {
        await trustEngine.recordInteraction({
          sourceEntityId: entityId,
          targetEntityId: runtime.agentId,
          type: TrustEvidenceType.SPAM_BEHAVIOR,
          timestamp: Date.now(),
          impact: -5,
          details: {
            description: 'High message frequency detected',
            messageCount: recentMessages.length,
            roomId: message.roomId,
            autoDetected: true,
          },
          context: {
            roomId: message.roomId,
          },
        });

        logger.warn('[TrustChangeEvaluator] High message frequency detected:', {
          entityId,
          messageCount: recentMessages.length,
        });
      }
      */

      return;
    } catch (error) {
      console.error('trustChangeEvaluator', error)
      logger.error({ error }, '[TrustChangeEvaluator] Error evaluating trust changes:');
      return;
    }
  },

  examples: [
    {
      prompt: 'User sends a helpful message',
      messages: [
        {
          name: '{{name1}}',
          content: {
            text: 'Thanks for helping me understand the trust system!',
          },
        },
      ],
      outcome: 'Positive behavior detected and trust increased',
    },
    {
      prompt: 'User exhibits spam behavior',
      messages: [
        {
          name: '{{name1}}',
          content: {
            text: 'SPAM SPAM SPAM SPAM SPAM',
          },
        },
      ],
      outcome: 'Negative behavior detected and trust decreased',
    },
  ],
};
