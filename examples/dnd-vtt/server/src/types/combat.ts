/**
 * D&D 5e Combat System Types
 * Turn-based combat state management
 */

import type { CharacterSheet, CharacterPosition } from './character';
import type { Monster } from './monster';
import type { DiceRollResult } from './dice';
import type { DamageType } from './damage';
import type { ConditionName } from './conditions';

// ============================================================================
// INITIATIVE
// ============================================================================

export type CombatantType = 'pc' | 'npc' | 'monster';

export interface InitiativeEntry {
  id: string;
  entityId: string;
  entityType: CombatantType;
  name: string;
  initiative: number;
  dexterity: number; // For tiebreaker
  hasActed: boolean;
  isDelaying: boolean;
  delayedUntilAfter?: string; // Entity ID to act after
}

// ============================================================================
// COMBAT ACTIONS
// ============================================================================

export type ActionType =
  | 'attack'
  | 'cast_spell'
  | 'dash'
  | 'disengage'
  | 'dodge'
  | 'help'
  | 'hide'
  | 'ready'
  | 'search'
  | 'use_object'
  | 'use_feature'
  | 'other';

export type BonusActionType =
  | 'offhand_attack'
  | 'cast_spell'
  | 'cunning_action'
  | 'second_wind'
  | 'use_feature'
  | 'other';

export type ReactionType =
  | 'opportunity_attack'
  | 'cast_spell'
  | 'shield'
  | 'counterspell'
  | 'uncanny_dodge'
  | 'use_feature'
  | 'other';

export interface CombatAction {
  type: ActionType;
  actorId: string;
  targetIds?: string[];
  spellId?: string;
  spellLevel?: number;
  weaponId?: string;
  featureId?: string;
  description: string;
  readiedTrigger?: string; // For Ready action
}

export interface CombatBonusAction {
  type: BonusActionType;
  actorId: string;
  targetIds?: string[];
  spellId?: string;
  spellLevel?: number;
  featureId?: string;
  description: string;
}

export interface CombatReaction {
  type: ReactionType;
  actorId: string;
  targetId?: string;
  triggerId: string; // What triggered this reaction
  spellId?: string;
  featureId?: string;
  description: string;
}

// ============================================================================
// ATTACK RESOLUTION
// ============================================================================

export interface AttackRoll {
  attackerId: string;
  defenderId: string;
  attackType: 'melee_weapon' | 'ranged_weapon' | 'melee_spell' | 'ranged_spell';
  weaponName?: string;
  spellName?: string;
  attackBonus: number;
  advantage: boolean;
  disadvantage: boolean;
  roll: DiceRollResult;
  targetAC: number;
  hit: boolean;
  criticalHit: boolean;
  criticalMiss: boolean;
}

export interface DamageRoll {
  attackerId: string;
  defenderId: string;
  damageRolls: {
    dice: string;
    type: DamageType;
    roll: DiceRollResult;
    finalDamage: number; // After resistances/immunities
  }[];
  totalDamage: number;
  killingBlow: boolean;
}

export interface SavingThrowResult {
  entityId: string;
  ability: string;
  dc: number;
  modifier: number;
  advantage: boolean;
  disadvantage: boolean;
  roll: DiceRollResult;
  success: boolean;
  halfDamageOnSuccess?: boolean;
  effectOnFailure?: string;
}

// ============================================================================
// COMBAT TURN
// ============================================================================

export interface TurnResources {
  action: boolean;
  bonusAction: boolean;
  reaction: boolean;
  movement: number;
  freeObjectInteraction: boolean;
}

export interface CombatTurn {
  turnNumber: number;
  entityId: string;
  entityType: CombatantType;
  startTime: Date;
  endTime?: Date;
  
  // Resources at start of turn
  availableResources: TurnResources;
  
  // Actions taken
  actionsTaken: CombatAction[];
  bonusActionsTaken: CombatBonusAction[];
  reactionsTaken: CombatReaction[];
  movementUsed: number;
  movementPath: CharacterPosition[];
  
  // Results
  attackRolls: AttackRoll[];
  damageRolls: DamageRoll[];
  savingThrows: SavingThrowResult[];
  
  // Conditions applied/removed
  conditionsApplied: { targetId: string; condition: ConditionName; source: string }[];
  conditionsRemoved: { targetId: string; condition: ConditionName }[];
}

// ============================================================================
// COMBAT ROUND
// ============================================================================

export interface CombatRound {
  roundNumber: number;
  startTime: Date;
  endTime?: Date;
  turns: CombatTurn[];
  legendaryActionsTaken: {
    monsterId: string;
    actionName: string;
    afterTurnOf: string;
  }[];
  lairActionTaken?: string;
}

// ============================================================================
// COMBAT STATE
// ============================================================================

export interface Combatant {
  id: string;
  entityId: string;
  entityType: CombatantType;
  name: string;
  
  // Current stats
  currentHP: number;
  maxHP: number;
  temporaryHP: number;
  armorClass: number;
  
  // Position
  position: CharacterPosition;
  
  // Turn state
  initiative: number;
  hasActed: boolean;
  availableResources: TurnResources;
  
  // Status effects
  concentratingOn?: string;
  deathSaves?: { successes: number; failures: number };
  
  // Reference to full data
  character?: CharacterSheet;
  monster?: Monster;
}

export interface CombatState {
  id: string;
  campaignId: string;
  sessionId: string;
  locationId: string;
  
  // Timing
  isActive: boolean;
  startTime: Date;
  endTime?: Date;
  
  // Participants
  combatants: Map<string, Combatant>;
  initiativeOrder: InitiativeEntry[];
  
  // Current state
  round: number;
  currentTurnIndex: number;
  
  // History
  rounds: CombatRound[];
  
  // Readied actions waiting to trigger
  readiedActions: {
    actorId: string;
    action: CombatAction;
    trigger: string;
  }[];
  
  // Environment
  mapId?: string;
  environmentEffects?: string[];
  
  // Outcome
  outcome?: 'victory' | 'defeat' | 'flee' | 'truce';
  xpAwarded?: number;
}

// ============================================================================
// COMBAT LOG ENTRY
// ============================================================================

export type CombatLogEntryType =
  | 'combat_start'
  | 'combat_end'
  | 'round_start'
  | 'round_end'
  | 'turn_start'
  | 'turn_end'
  | 'attack'
  | 'damage'
  | 'healing'
  | 'spell_cast'
  | 'saving_throw'
  | 'condition_applied'
  | 'condition_removed'
  | 'movement'
  | 'death'
  | 'stabilize'
  | 'death_save'
  | 'legendary_action'
  | 'lair_action'
  | 'reaction'
  | 'other';

export interface CombatLogEntry {
  id: string;
  timestamp: Date;
  type: CombatLogEntryType;
  round: number;
  turn?: number;
  actorId?: string;
  actorName?: string;
  targetId?: string;
  targetName?: string;
  description: string;
  details?: Record<string, unknown>;
  isPublic: boolean; // false = DM only
}

// ============================================================================
// COMBAT HELPER FUNCTIONS
// ============================================================================

/**
 * Sort initiative order (highest first, DEX tiebreaker)
 */
export function sortInitiativeOrder(entries: InitiativeEntry[]): InitiativeEntry[] {
  return [...entries].sort((a, b) => {
    if (b.initiative !== a.initiative) {
      return b.initiative - a.initiative;
    }
    // Tiebreaker: higher DEX goes first
    return b.dexterity - a.dexterity;
  });
}

/**
 * Get next combatant in initiative order
 */
export function getNextCombatant(
  initiativeOrder: InitiativeEntry[],
  currentIndex: number
): { entry: InitiativeEntry; index: number } {
  let nextIndex = (currentIndex + 1) % initiativeOrder.length;
  let entry = initiativeOrder[nextIndex];
  
  // Skip any combatants that are delaying
  let safetyCounter = 0;
  while (entry.isDelaying && safetyCounter < initiativeOrder.length) {
    nextIndex = (nextIndex + 1) % initiativeOrder.length;
    entry = initiativeOrder[nextIndex];
    safetyCounter++;
  }
  
  return { entry, index: nextIndex };
}

/**
 * Check if combat should end
 */
export function shouldCombatEnd(combatants: Map<string, Combatant>): {
  shouldEnd: boolean;
  outcome?: 'victory' | 'defeat' | 'truce';
} {
  const pcs = Array.from(combatants.values()).filter(c => c.entityType === 'pc');
  const enemies = Array.from(combatants.values()).filter(c => c.entityType === 'monster');
  
  const allPCsDown = pcs.every(pc => pc.currentHP <= 0);
  const allEnemiesDown = enemies.every(e => e.currentHP <= 0);
  
  if (allEnemiesDown && !allPCsDown) {
    return { shouldEnd: true, outcome: 'victory' };
  }
  
  if (allPCsDown && !allEnemiesDown) {
    return { shouldEnd: true, outcome: 'defeat' };
  }
  
  if (allPCsDown && allEnemiesDown) {
    return { shouldEnd: true, outcome: 'truce' };
  }
  
  return { shouldEnd: false };
}

/**
 * Create fresh turn resources
 */
export function createFreshTurnResources(speed: number): TurnResources {
  return {
    action: true,
    bonusAction: true,
    reaction: true,
    movement: speed,
    freeObjectInteraction: true,
  };
}

/**
 * Check if a creature can take opportunity attacks
 */
export function canTakeOpportunityAttack(combatant: Combatant): boolean {
  if (!combatant.availableResources.reaction) return false;
  if (combatant.currentHP <= 0) return false;
  // Check for incapacitating conditions on the character/monster
  return true;
}

/**
 * Calculate distance between two positions (in feet, assuming 5ft grid)
 */
export function calculateDistance(pos1: CharacterPosition, pos2: CharacterPosition): number {
  const dx = Math.abs(pos1.x - pos2.x);
  const dy = Math.abs(pos1.y - pos2.y);
  // Using 5ft grid squares
  return Math.max(dx, dy) * 5;
}

/**
 * Check if movement triggers opportunity attack
 */
export function triggersOpportunityAttack(
  moverId: string,
  fromPos: CharacterPosition,
  toPos: CharacterPosition,
  combatants: Map<string, Combatant>,
  moverIsDisengaging: boolean
): { triggeredBy: string; position: CharacterPosition }[] {
  if (moverIsDisengaging) return [];
  
  const triggers: { triggeredBy: string; position: CharacterPosition }[] = [];
  
  for (const [id, combatant] of combatants) {
    if (id === moverId) continue;
    if (combatant.currentHP <= 0) continue;
    if (!canTakeOpportunityAttack(combatant)) continue;
    
    // Check if we're leaving their reach (assumed 5ft for most creatures)
    const reach = 5; // Could be extended for reach weapons
    const wasInReach = calculateDistance(fromPos, combatant.position) <= reach;
    const isInReach = calculateDistance(toPos, combatant.position) <= reach;
    
    if (wasInReach && !isInReach) {
      triggers.push({ triggeredBy: id, position: fromPos });
    }
  }
  
  return triggers;
}
