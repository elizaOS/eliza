/**
 * Combat System Index
 */

// Combat state types
export type {
  Combatant,
  CombatEncounter,
  CombatLogEntry,
  CombatActionType,
  DiceRollResult,
  EnvironmentalEffect,
} from './combat-state';

export {
  createCombatantFromCharacter,
  createCombatantFromMonster,
  resetTurnResources,
  isIncapacitated,
  canTakeReaction,
  isDead,
  isStable,
} from './combat-state';

// Initiative tracking
export type {
  InitiativeRoll,
  ReadiedAction,
} from './initiative-tracker';

export {
  rollInitiative,
  rollGroupInitiative,
  setInitiativeOrder,
  addToInitiative,
  removeFromInitiative,
  getCurrentCombatant,
  advanceTurn,
  delayTurn,
  formatInitiativeOrder,
} from './initiative-tracker';

// Damage and healing
export type {
  DamageInstance,
  DamageResult,
  HealingResult,
} from './damage-healing';

export {
  applyDamage,
  applyMultipleDamage,
  applyHealing,
  applyTempHP,
  rollDamage,
  averageDamage,
  checkConcentration,
  breakConcentration,
  applyDamageWhileDying,
  describeDamage,
} from './damage-healing';

// Condition management
export type {
  ConditionDefinition,
  ConditionEffect,
} from './conditions';

export {
  CONDITIONS,
  applyCondition,
  removeCondition,
  removeConditionsFromSource,
  hasCondition,
  getExhaustionLevel,
  addExhaustion,
  reduceExhaustion,
  getAttackModifiers,
  getDefenseModifiers,
  getSaveModifiers,
  describeConditionApplied,
} from './conditions';

// Combat actions
export type {
  ActionResult,
} from './combat-actions';

export {
  executeAttack,
  executeDash,
  executeDisengage,
  executeDodge,
  executeHelp,
  executeHide,
  executeReady,
  executeSearch,
  executeGrapple,
  executeShove,
  executeDeathSave,
  executeMovement,
  executeStandUp,
} from './combat-actions';

// Shared utilities
export {
  getCondName,
  extractConditionNames,
  hasCondByName,
  normalizeHP,
  buildCharacterPayload,
} from './condition-utils';

// Stat resolution
export { resolveCombatStats, findSpell, hasSpellSlot } from './stat-resolver';

// Spell effects
export { applySpellEffect } from './spell-effects';

// Combat manager
export {
  createEncounter,
  addPartyToEncounter,
  addMonstersToEncounter,
  startCombat,
  endTurn,
  updateCombatant,
  updateCombatants,
  addLogEntry,
  shouldCombatEnd,
  endCombat,
  getCombatSummary,
  logCombatToDatabase,
  formatCombatStatus,
} from './combat-manager';
