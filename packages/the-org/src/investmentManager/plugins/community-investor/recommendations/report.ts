import { type Action, type Memory, type UUID, logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { formatRecommenderReport } from '../reports';
import type { CommunityInvestorService } from '../tradingService';
import { ServiceType } from '../types';

/**
 * Action for getting a entity's report scoring their recommendations
 * @type {Action}
 * @name GET_RECOMMENDER_REPORT
 * @description Gets a entity's report scoring their recommendations
 * @example
 * [
 *   [
 *     {
 *       name: "{{name1}}",
 *       content: {
 *         text: "what is my entity score?",
 *       },
 *     },
 *     {
 *       name: "{{name2}}",
 *       content: {
 *         text: "<NONE>",
 *         actions: ["GET_RECOMMENDER_REPORT"],
 *       },
 *     },
 *   ],
 *   [
 *     {
 *       name: "{{name1}}",
 *       content: {
 *         text: "please provide my entity report",
 *       },
 *     },
 *     {
 *       name: "{{name2}}",
 *       content: {
 *         text: "<NONE>",
 *         actions: ["GET_RECOMMENDER_REPORT"],
 *       },
 *     },
 *   ],
 * ]
 * @similes RECOMMENDER_REPORT, RECOMMENDER_SCORE
 */
export const getRecommenderReport: Action = {
  name: 'GET_RECOMMENDER_REPORT',
  description: "Gets a entity's report scoring their recommendations",
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'what is my entity score?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '<NONE>',
          actions: ['GET_RECOMMENDER_REPORT'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'please provide my entity report',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '<NONE>',
          actions: ['GET_RECOMMENDER_REPORT'],
        },
      },
    ],
  ],
  similes: ['RECOMMENDER_REPORT', 'RECOMMENDER_SCORE'],

  async handler(runtime, message, _state, _options, callback: any) {
    if (!callback) {
      logger.error('No callback provided, no entity score can be generated');
      return;
    }

    const entity = await runtime.getEntityById(message.entityId);

    if (!entity) {
      logger.error('No entity found, no entity score can be generated');
      return;
    }
    const tradingService = runtime.getService<CommunityInvestorService>(
      ServiceType.COMMUNITY_INVESTOR
    );

    const metrics = entity ? await tradingService.getRecommenderMetrics(entity.id) : undefined;

    if (!metrics?.trustScore || metrics.trustScore === 0 || metrics.trustScore === -100) {
      const responseMemory: Memory = {
        content: {
          text: "You don't have a entity score yet. Please start recommending tokens to earn a score.",
          inReplyTo: message.id ? message.id : undefined,
          actions: ['GET_RECOMMENDER_REPORT'],
        },
        entityId: message.entityId,
        agentId: message.agentId,
        roomId: message.roomId,
        metadata: message.metadata,
        createdAt: Date.now() * 1000,
      };
      await callback(responseMemory);
      return true;
    }

    logger.info(`Recommender report for ${entity?.id}: ${metrics?.trustScore}`);
    const recommenderReport =
      entity && metrics
        ? formatRecommenderReport(
            {
              ...entity,
              id: entity.id as UUID, // Ensure id is not undefined
            },
            metrics,
            (await tradingService.getRecommenderMetricsHistory(entity.id)).map((history) => ({
              ...history,
              historyId: history.entityId || uuidv4(), // Ensure historyId is a valid UUID
              entityId: history.entityId || '',
              trustScore: history.metrics.trustScore || 0,
              totalRecommendations: history.metrics.totalRecommendations || 0,
              successfulRecs: history.metrics.successfulRecs || 0,
              avgTokenPerformance: history.metrics.avgTokenPerformance || 0,
              consistencyScore: history.metrics.consistencyScore || 0,
              lastUpdated: history.timestamp || new Date(),
            })) as import('../types').RecommenderMetricsHistory[]
          )
        : '';
    logger.info(`Recommender report: ${recommenderReport}`);
    const responseMemory: Memory = {
      content: {
        text: recommenderReport,
        actions: ['GET_RECOMMENDER_REPORT'],
      },
      entityId: message.entityId,
      agentId: message.agentId,
      roomId: message.roomId,
      metadata: message.metadata,
      createdAt: Date.now() * 1000,
    };
    await callback(responseMemory);
    return true;
  },
  async validate(_, message) {
    if (message.agentId === message.entityId) return false;
    return true;
  },
};
