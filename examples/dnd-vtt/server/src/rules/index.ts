/**
 * Rules Engine Index
 * Central exports for D&D 5e rules
 */

// Ability Checks
export {
  makeAbilityCheck,
  makeSkillCheck,
  makeContestedCheck,
  getPassiveScore,
  getDCByDifficulty,
  DIFFICULTY_CLASS,
} from './ability-checks';
export type {
  AbilityCheckParams,
  AbilityCheckResult,
  SkillCheckParams,
  SkillCheckResult,
  ContestedCheckParams,
  ContestedCheckResult,
  DifficultyLevel,
} from './ability-checks';

// Attack Rolls
export {
  makeAttackRoll,
  getCoverBonus,
  isInMeleeRange,
} from './attack-rolls';
export type {
  AttackType,
  AttackParams,
  AttackResult,
} from './attack-rolls';

// Saving Throws
export {
  makeSavingThrow,
  calculateSpellSaveDC,
  makeSpellSave,
  makeDeathSave,
  makeConcentrationCheck,
  SAVE_DCS_BY_CHALLENGE,
} from './saving-throws';
export type {
  SavingThrowParams,
  SavingThrowResult,
  SpellSaveParams,
} from './saving-throws';

// Rest
export {
  takeShortRest,
  takeLongRest,
  getHitDieType,
  calculateHitDiceRemaining,
  restoreSpellSlots,
  canTakeLongRest,
  restoreWarlockSlots,
} from './rest';
export type {
  ShortRestParams,
  ShortRestResult,
  LongRestParams,
  LongRestResult,
} from './rest';

// Movement
export {
  getBaseSpeed,
  getModifiedSpeed,
  calculateDistance,
  findPath,
  isAdjacent,
  getAdjacentPositions,
  getOpportunityAttackTriggers,
  getTerrainCost,
  standUpCost,
  canStandUp,
  calculateMovement,
  MOVEMENT_ACTIONS,
} from './movement';
export type {
  Position,
  MovementParams,
  MovementResult,
  CreatureSpeed,
} from './movement';
