/**
 * DM Plugin
 * ElizaOS plugin providing DM capabilities
 */

import type { 
  Plugin, 
  Action, 
  Provider, 
  Evaluator,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';

import {
  narrateSceneAction,
  describeLocationAction,
  controlNPCAction,
  startCombatAction,
  resolveCombatTurnAction,
  callForRollAction,
  adjudicateActionAction,
  advanceTimeAction,
} from './actions';

import {
  campaignStateProvider,
  combatStateProvider,
  partyStatusProvider,
  locationProvider,
  npcContextProvider,
  worldEventProvider,
} from './providers';

import {
  narrativeQualityEvaluator,
  ruleAccuracyEvaluator,
  pacingEvaluator,
  playerEngagementEvaluator,
} from './evaluators';

/**
 * DM Plugin definition
 */
export const dmPlugin: Plugin = {
  name: 'dnd-dm',
  description: 'D&D 5e Dungeon Master capabilities for narrative, combat, and world management',
  
  actions: [
    narrateSceneAction,
    describeLocationAction,
    controlNPCAction,
    startCombatAction,
    resolveCombatTurnAction,
    callForRollAction,
    adjudicateActionAction,
    advanceTimeAction,
  ],
  
  providers: [
    campaignStateProvider,
    combatStateProvider,
    partyStatusProvider,
    locationProvider,
    npcContextProvider,
    worldEventProvider,
  ],
  
  evaluators: [
    narrativeQualityEvaluator,
    ruleAccuracyEvaluator,
    pacingEvaluator,
    playerEngagementEvaluator,
  ],
  
  services: [],
};

export default dmPlugin;
