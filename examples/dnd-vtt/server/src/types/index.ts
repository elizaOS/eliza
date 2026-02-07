/**
 * D&D 5e Type Definitions - Central Export
 * All game types for the VTT
 */

// Abilities
export {
  type AbilityName,
  type AbilityScores,
  ABILITY_NAMES,
  ABILITY_ABBREVIATIONS,
  STANDARD_ARRAY,
  POINT_BUY_COSTS,
  calculateModifier,
  getProficiencyBonus,
} from './abilities';

// Skills
export {
  type SkillName,
  type SkillDefinition,
  SKILLS,
  calculateSkillModifier,
  calculatePassiveScore,
} from './skills';

// Dice
export {
  type DieType,
  type DiceRoll,
  type DiceRollResult,
  DIE_TYPES as DICE_TYPES,
  rollDie,
  rollDice,
  executeDiceRoll,
  parseDiceNotation,
  formatDiceRollResult,
  rollInitiative,
  rollAbilityCheck,
  rollSavingThrow,
  rollAttack,
  rollDamage,
  rollHitDice,
  rollPercentile,
  rollAbilityScore,
} from './dice';

// Conditions
export {
  type ConditionName,
  type ConditionEffectType,
  type ConditionEffect,
  type ConditionDefinition,
  type ConditionDuration,
  type ActiveCondition,
  CONDITIONS,
  normalizeCondition,
  getCondition,
  getConditionName,
  getConditionSource,
  hasCondition,
  isConditionActive,
  isIncapacitated,
  getExhaustionEffects,
  attacksHaveAdvantage,
  attacksHaveDisadvantage,
  removeCondition,
  addCondition,
  tickConditionDurations,
} from './conditions';

// Damage
export {
  type DamageType,
  type DamageModifier,
  type DamageModifierType,
  type DamageInstance,
  DAMAGE_TYPE_DEFINITIONS,
  calculateFinalDamage,
} from './damage';

// Characters
export {
  type Race,
  type CharacterClass,
  type Alignment,
  type ArmorType,
  type WeaponType,
  type WeaponProperty,
  type ItemRarity,
  type ItemType,
  type Item,
  type InventoryItem,
  type Currency,
  type SpellSchool,
  type Spell,
  type HitPoints,
  type HitDice,
  type DeathSaves,
  type Proficiencies,
  type Personality,
  type AbilityWithModifier,
  type FlexibleAbilities,
  type EquipmentSet,
  type CharacterSheet,
  type CharacterPosition,
  type CharacterCombatState,
  type CalculatedStats,
  getAC,
  getHP,
  getAbilityMod,
  getAbilityScore,
} from './character';

// Monsters
export {
  type MonsterType,
  type Size,
  type MonsterAbilities,
  type MonsterSpeed,
  type MonsterSenses,
  type MonsterAction,
  type MonsterTrait,
  type LegendaryAction,
  type Reaction,
  type Monster,
  type NPC,
  type EncounterMonster,
  type Encounter,
  CR_TO_XP,
  CR_TO_PROFICIENCY,
  calculateEncounterThresholds,
  calculateAdjustedXP,
  getXPForCR,
  getProficiencyForCR,
} from './monster';

// Combat
export {
  type CombatantType,
  type ActionType as CombatActionType,
  type BonusActionType as CombatBonusActionType,
  type ReactionType as CombatReactionType,
  type CombatBonusAction,
  type CombatReaction,
  type Combatant,
  type InitiativeEntry,
  type CombatAction,
  type CombatTurn,
  type CombatRound,
  type CombatState,
  type AttackRoll,
  type DamageRoll,
  type SavingThrowResult,
  type CombatLogEntry,
  type CombatLogEntryType,
  type TurnResources,
  getNextCombatant,
  sortInitiativeOrder,
  shouldCombatEnd,
  createFreshTurnResources,
  canTakeOpportunityAttack,
  calculateDistance,
  triggersOpportunityAttack,
} from './combat';

// Campaign
export {
  type GameTime,
  type GameDate,
  type CampaignSettings,
  type Campaign,
  type SessionSummary,
  type Session,
  type LocationType,
  type TerrainType,
  type LocationConnection,
  type LocationFeature,
  type Location,
  type BattleMapCell,
  type BattleMap,
  type WorldEventType,
  type WorldEvent,
  type QuestStatus,
  type QuestObjective,
  type Quest,
  type CharacterMemory,
  type CharacterRelationship,
  type NPCMemory,
  type GamePhase,
  type GameState,
  formatGameTime,
  advanceGameTime,
  getTimeDifferenceMinutes,
  getTimeOfDay,
} from './campaign';

// VTT
export {
  type VTTToken,
  type TokenSize,
  type TokenVisibility,
  type VTTMap,
  type VTTMarker,
  type VTTDrawing,
  type VTTLightSource,
  type ChatMessageType,
  type ChatMessage,
  type VTTInitiativeEntry,
  type VTTInitiativeTracker,
  type VTTPlayer,
  type VTTClientEvents,
  type VTTServerEvents,
  type VTTSessionState,
  gridToPixel,
  pixelToGrid,
} from './vtt';
