/**
 * Player Plugin
 * ElizaOS plugin providing player character capabilities
 */

import type { Plugin } from '@elizaos/core';

import {
  declareActionAction,
  performSkillCheckAction,
  castSpellAction,
  useItemAction,
  interactWithNPCAction,
  exploreAction,
  respondToPartyAction,
  shortRestAction,
} from './actions';

import {
  characterSheetProvider,
  partyContextProvider,
  currentSituationProvider,
  combatOptionsProvider,
  memoryProvider,
} from './providers';

import {
  inCharacterEvaluator,
  tacticalDecisionEvaluator,
  partyCooperationEvaluator,
} from './evaluators';

/**
 * Player Plugin definition
 */
export const playerPlugin: Plugin = {
  name: 'dnd-player',
  description: 'D&D 5e player character capabilities for autonomous roleplay',
  
  actions: [
    declareActionAction,
    performSkillCheckAction,
    castSpellAction,
    useItemAction,
    interactWithNPCAction,
    exploreAction,
    respondToPartyAction,
    shortRestAction,
  ],
  
  providers: [
    characterSheetProvider,
    partyContextProvider,
    currentSituationProvider,
    combatOptionsProvider,
    memoryProvider,
  ],
  
  evaluators: [
    inCharacterEvaluator,
    tacticalDecisionEvaluator,
    partyCooperationEvaluator,
  ],
  
  services: [],
};

export default playerPlugin;
