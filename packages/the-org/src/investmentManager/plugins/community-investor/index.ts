import type { Plugin } from '@elizaos/core';
import { getAgentPositions } from './recommendations/agentPositions';
import { getTokenDetails } from './recommendations/analysis';
import { confirmRecommendation } from './recommendations/confirm';
import { recommendationEvaluator } from './recommendations/evaluator';
import { getPositions } from './recommendations/positions';
import { getRecommenderReport } from './recommendations/report';
import { getSimulatedPositions } from './recommendations/simulatedPositions';
import { CommunityInvestorService } from './tradingService';

/**
 * Plugin representing the Community Investor Plugin for Eliza.
 * Includes evaluators, actions, and services for community investment functionality.
 */
export const communityInvestorPlugin: Plugin = {
  name: 'community-investor',
  description: 'Community Investor Plugin for Eliza',
  evaluators: [recommendationEvaluator],
  providers: [],
  actions: [
    confirmRecommendation,
    getTokenDetails,
    getRecommenderReport,
    getPositions,
    getAgentPositions,
    getSimulatedPositions,
  ],
  services: [CommunityInvestorService],
};
