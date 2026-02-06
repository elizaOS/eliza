/**
 * Combat State Tests
 * Tests for combat encounter management and state transitions
 */

import { describe, test, expect } from 'bun:test';
import {
  createCombatantFromCharacter,
  createCombatantFromMonster,
  resetTurnResources,
  isIncapacitated,
  canTakeReaction,
  isDead,
  isStable,
  type Combatant,
  type CombatEncounter,
} from '../combat/combat-state';
import type { CharacterSheet, Monster } from '../types';

// Helper to create a test character sheet
function createTestCharacter(overrides: Partial<CharacterSheet> = {}): CharacterSheet {
  return {
    id: 'char-1',
    name: 'Test Hero',
    race: 'Human',
    class: 'Fighter',
    level: 5,
    background: 'Soldier',
    alignment: 'Lawful Good',
    abilities: {
      strength: { score: 16, modifier: 3 },
      dexterity: { score: 14, modifier: 2 },
      constitution: { score: 14, modifier: 2 },
      intelligence: { score: 10, modifier: 0 },
      wisdom: { score: 12, modifier: 1 },
      charisma: { score: 8, modifier: -1 },
    },
    hitPoints: { current: 44, max: 44, temporary: 0 },
    hp: { current: 44, max: 44, temp: 0 },
    ac: 18,
    armorClass: 18,
    speed: 30,
    proficiencies: { skills: [], savingThrows: [], weapons: [], armor: [], tools: [], languages: [] },
    conditions: [],
    isAI: false,
    ...overrides,
  } as CharacterSheet;
}

// Helper to create a test monster
function createTestMonster(overrides: Partial<Monster> = {}): Monster {
  return {
    id: 'mon-1',
    name: 'Goblin',
    size: 'Small',
    type: 'humanoid',
    alignment: 'Neutral Evil',
    abilities: {
      str: 8,
      dex: 14,
      con: 10,
      int: 10,
      wis: 8,
      cha: 8,
      strength: 8,
      dexterity: 14,
      constitution: 10,
      intelligence: 10,
      wisdom: 8,
      charisma: 8,
    },
    hp: { current: 7, max: 7, temp: 0 },
    ac: 15,
    speed: { walk: 30 },
    challengeRating: 0.25,
    ...overrides,
  } as Monster;
}

describe('Combat State', () => {
  // ============================================================================
  // COMBATANT CREATION
  // ============================================================================
  describe('createCombatantFromCharacter', () => {
    test('creates combatant with correct basic info', () => {
      const character = createTestCharacter();
      const combatant = createCombatantFromCharacter(character, 15);
      
      expect(combatant.name).toBe('Test Hero');
      expect(combatant.type).toBe('pc');
      expect(combatant.initiative).toBe(15);
    });

    test('copies HP correctly', () => {
      const character = createTestCharacter({ hp: { current: 30, max: 44, temp: 5 } });
      const combatant = createCombatantFromCharacter(character, 10);
      
      expect(combatant.hp.current).toBe(30);
      expect(combatant.hp.max).toBe(44);
      expect(combatant.hp.temp).toBe(5);
    });

    test('sets correct dexterity modifier', () => {
      const character = createTestCharacter({
        abilities: {
          ...createTestCharacter().abilities,
          dexterity: { score: 18, modifier: 4 },
        },
      });
      const combatant = createCombatantFromCharacter(character, 20);
      
      expect(combatant.dexterityModifier).toBe(4);
    });

    test('initializes death saves at zero', () => {
      const character = createTestCharacter();
      const combatant = createCombatantFromCharacter(character, 12);
      
      expect(combatant.deathSaves?.successes).toBe(0);
      expect(combatant.deathSaves?.failures).toBe(0);
    });

    test('initializes turn resources correctly', () => {
      const character = createTestCharacter({ speed: 35 });
      const combatant = createCombatantFromCharacter(character, 10);
      
      expect(combatant.turnResources.actionUsed).toBe(false);
      expect(combatant.turnResources.bonusActionUsed).toBe(false);
      expect(combatant.turnResources.reactionUsed).toBe(false);
      expect(combatant.turnResources.movementRemaining).toBe(35);
      expect(combatant.turnResources.freeObjectInteraction).toBe(true);
    });

    test('copies conditions from character', () => {
      const character = createTestCharacter({
        conditions: [{ condition: 'poisoned', sourceId: 'spell' }],
      });
      const combatant = createCombatantFromCharacter(character, 10);
      
      expect(combatant.conditions.length).toBe(1);
      expect(combatant.conditions[0].condition).toBe('poisoned');
    });

    test('links back to source character', () => {
      const character = createTestCharacter({ id: 'hero-123' });
      const combatant = createCombatantFromCharacter(character, 10);
      
      expect(combatant.sourceId).toBe('hero-123');
      expect(combatant.sourceType).toBe('character');
    });
  });

  describe('createCombatantFromMonster', () => {
    test('creates combatant with correct name', () => {
      const monster = createTestMonster({ name: 'Dire Wolf' });
      const combatant = createCombatantFromMonster(monster, 12);
      
      expect(combatant.name).toBe('Dire Wolf');
      expect(combatant.type).toBe('monster');
    });

    test('adds instance number suffix', () => {
      const monster = createTestMonster({ name: 'Goblin' });
      const combatant = createCombatantFromMonster(monster, 12, 2);
      
      expect(combatant.name).toBe('Goblin 3'); // 0-indexed, so instance 2 = #3
    });

    test('calculates dex modifier from ability score', () => {
      const monster = createTestMonster({
        abilities: { ...createTestMonster().abilities, dex: 16 },
      });
      const combatant = createCombatantFromMonster(monster, 14);
      
      expect(combatant.dexterityModifier).toBe(3); // (16-10)/2 = 3
    });

    test('uses walk speed', () => {
      const monster = createTestMonster({ speed: { walk: 40, fly: 60 } });
      const combatant = createCombatantFromMonster(monster, 10);
      
      expect(combatant.speed).toBe(40);
    });

    test('defaults to 30 if no walk speed', () => {
      const monster = createTestMonster({ speed: { swim: 60 } as Monster['speed'] });
      const combatant = createCombatantFromMonster(monster, 10);
      
      expect(combatant.speed).toBe(30);
    });

    test('copies resistances and immunities', () => {
      const monster = createTestMonster({
        resistances: ['fire', 'cold'],
        immunities: ['poison'],
        vulnerabilities: ['radiant'],
      });
      const combatant = createCombatantFromMonster(monster, 10);
      
      expect(combatant.resistances).toContain('fire');
      expect(combatant.immunities).toContain('poison');
      expect(combatant.vulnerabilities).toContain('radiant');
    });
  });

  // ============================================================================
  // TURN RESOURCE MANAGEMENT
  // ============================================================================
  describe('resetTurnResources', () => {
    test('resets all action flags', () => {
      const combatant: Combatant = {
        id: 'test',
        name: 'Test',
        type: 'pc',
        initiative: 10,
        dexterityModifier: 2,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 20, max: 20, temp: 0 },
        ac: 15,
        speed: 30,
        conditions: [],
        turnResources: {
          actionUsed: true,
          bonusActionUsed: true,
          reactionUsed: true,
          movementRemaining: 0,
          freeObjectInteraction: false,
        },
        sourceId: 'char-1',
        sourceType: 'character',
      };
      
      const reset = resetTurnResources(combatant);
      
      expect(reset.turnResources.actionUsed).toBe(false);
      expect(reset.turnResources.bonusActionUsed).toBe(false);
      expect(reset.turnResources.reactionUsed).toBe(false);
      expect(reset.turnResources.freeObjectInteraction).toBe(true);
    });

    test('restores movement to full speed', () => {
      const combatant: Combatant = {
        id: 'test',
        name: 'Test',
        type: 'pc',
        initiative: 10,
        dexterityModifier: 2,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 20, max: 20, temp: 0 },
        ac: 15,
        speed: 35,
        conditions: [],
        turnResources: {
          actionUsed: false,
          bonusActionUsed: false,
          reactionUsed: false,
          movementRemaining: 5,
          freeObjectInteraction: false,
        },
        sourceId: 'char-1',
        sourceType: 'character',
      };
      
      const reset = resetTurnResources(combatant);
      
      expect(reset.turnResources.movementRemaining).toBe(35);
    });

    test('does not mutate original combatant', () => {
      const combatant: Combatant = {
        id: 'test',
        name: 'Test',
        type: 'pc',
        initiative: 10,
        dexterityModifier: 2,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 20, max: 20, temp: 0 },
        ac: 15,
        speed: 30,
        conditions: [],
        turnResources: {
          actionUsed: true,
          bonusActionUsed: true,
          reactionUsed: true,
          movementRemaining: 0,
          freeObjectInteraction: false,
        },
        sourceId: 'char-1',
        sourceType: 'character',
      };
      
      resetTurnResources(combatant);
      
      expect(combatant.turnResources.actionUsed).toBe(true);
    });
  });

  // ============================================================================
  // INCAPACITATION CHECKS
  // ============================================================================
  describe('isIncapacitated', () => {
    function makeCombatant(conditions: Combatant['conditions']): Combatant {
      return {
        id: 'test',
        name: 'Test',
        type: 'pc',
        initiative: 10,
        dexterityModifier: 0,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 10, max: 20, temp: 0 },
        ac: 15,
        speed: 30,
        conditions,
        turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'char-1',
        sourceType: 'character',
      };
    }

    test('returns true for Incapacitated condition', () => {
      const combatant = makeCombatant([{ name: 'Incapacitated' }]);
      expect(isIncapacitated(combatant)).toBe(true);
    });

    test('returns true for Paralyzed condition', () => {
      const combatant = makeCombatant([{ name: 'Paralyzed' }]);
      expect(isIncapacitated(combatant)).toBe(true);
    });

    test('returns true for Petrified condition', () => {
      const combatant = makeCombatant([{ name: 'Petrified' }]);
      expect(isIncapacitated(combatant)).toBe(true);
    });

    test('returns true for Stunned condition', () => {
      const combatant = makeCombatant([{ name: 'Stunned' }]);
      expect(isIncapacitated(combatant)).toBe(true);
    });

    test('returns true for Unconscious condition', () => {
      const combatant = makeCombatant([{ name: 'Unconscious' }]);
      expect(isIncapacitated(combatant)).toBe(true);
    });

    test('returns false for non-incapacitating conditions', () => {
      const combatant = makeCombatant([{ name: 'Poisoned' }, { name: 'Blinded' }]);
      expect(isIncapacitated(combatant)).toBe(false);
    });

    test('returns false for no conditions', () => {
      const combatant = makeCombatant([]);
      expect(isIncapacitated(combatant)).toBe(false);
    });
  });

  // ============================================================================
  // REACTION AVAILABILITY
  // ============================================================================
  describe('canTakeReaction', () => {
    function makeCombatant(
      conditions: Combatant['conditions'],
      reactionUsed = false
    ): Combatant {
      return {
        id: 'test',
        name: 'Test',
        type: 'pc',
        initiative: 10,
        dexterityModifier: 0,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 10, max: 20, temp: 0 },
        ac: 15,
        speed: 30,
        conditions,
        turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'char-1',
        sourceType: 'character',
      };
    }

    test('returns true if no conditions and reaction not used', () => {
      const combatant = makeCombatant([], false);
      expect(canTakeReaction(combatant)).toBe(true);
    });

    test('returns false if reaction already used', () => {
      const combatant = makeCombatant([], true);
      expect(canTakeReaction(combatant)).toBe(false);
    });

    test('returns false if Petrified', () => {
      const combatant = makeCombatant([{ name: 'Petrified' }]);
      expect(canTakeReaction(combatant)).toBe(false);
    });

    test('returns false if Unconscious', () => {
      const combatant = makeCombatant([{ name: 'Unconscious' }]);
      expect(canTakeReaction(combatant)).toBe(false);
    });

    test('returns false if Paralyzed', () => {
      const combatant = makeCombatant([{ name: 'Paralyzed' }]);
      expect(canTakeReaction(combatant)).toBe(false);
    });

    test('returns false if Stunned', () => {
      const combatant = makeCombatant([{ name: 'Stunned' }]);
      expect(canTakeReaction(combatant)).toBe(false);
    });

    test('returns true with non-blocking conditions', () => {
      const combatant = makeCombatant([{ name: 'Poisoned' }, { name: 'Frightened' }]);
      expect(canTakeReaction(combatant)).toBe(true);
    });
  });

  // ============================================================================
  // DEATH CHECKS
  // ============================================================================
  describe('isDead', () => {
    function makeCombatant(
      type: 'pc' | 'monster',
      hp: number,
      deathSaves?: { successes: number; failures: number }
    ): Combatant {
      return {
        id: 'test',
        name: 'Test',
        type,
        initiative: 10,
        dexterityModifier: 0,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: hp, max: 20, temp: 0 },
        ac: 15,
        speed: 30,
        conditions: [],
        deathSaves,
        turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'char-1',
        sourceType: type === 'pc' ? 'character' : 'monster',
      };
    }

    test('monster is dead at 0 HP', () => {
      const monster = makeCombatant('monster', 0);
      expect(isDead(monster)).toBe(true);
    });

    test('monster is not dead with positive HP', () => {
      const monster = makeCombatant('monster', 1);
      expect(isDead(monster)).toBe(false);
    });

    test('PC is not dead at 0 HP with less than 3 failures', () => {
      const pc = makeCombatant('pc', 0, { successes: 0, failures: 2 });
      expect(isDead(pc)).toBe(false);
    });

    test('PC is dead with 3 death save failures', () => {
      const pc = makeCombatant('pc', 0, { successes: 2, failures: 3 });
      expect(isDead(pc)).toBe(true);
    });

    test('PC with positive HP is not dead', () => {
      const pc = makeCombatant('pc', 1, { successes: 0, failures: 3 });
      expect(isDead(pc)).toBe(false);
    });
  });

  // ============================================================================
  // STABILITY CHECKS
  // ============================================================================
  describe('isStable', () => {
    function makeCombatant(
      type: 'pc' | 'monster',
      hp: number,
      deathSaves?: { successes: number; failures: number }
    ): Combatant {
      return {
        id: 'test',
        name: 'Test',
        type,
        initiative: 10,
        dexterityModifier: 0,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: hp, max: 20, temp: 0 },
        ac: 15,
        speed: 30,
        conditions: [],
        deathSaves,
        turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: type === 'pc' ? 'char-1' : 'mon-1',
        sourceType: type === 'pc' ? 'character' : 'monster',
      };
    }

    test('PC is stable at 0 HP with 3 successes', () => {
      const pc = makeCombatant('pc', 0, { successes: 3, failures: 2 });
      expect(isStable(pc)).toBe(true);
    });

    test('PC is not stable at 0 HP with less than 3 successes', () => {
      const pc = makeCombatant('pc', 0, { successes: 2, failures: 1 });
      expect(isStable(pc)).toBe(false);
    });

    test('PC with positive HP is not considered stable (not unconscious)', () => {
      const pc = makeCombatant('pc', 5, { successes: 3, failures: 0 });
      expect(isStable(pc)).toBe(false);
    });

    test('monster is never stable (just dead or alive)', () => {
      const monster = makeCombatant('monster', 0);
      expect(isStable(monster)).toBe(false);
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================
  describe('edge cases', () => {
    test('handles negative HP (should be treated as 0)', () => {
      const monster: Combatant = {
        id: 'test',
        name: 'Test',
        type: 'monster',
        initiative: 10,
        dexterityModifier: 0,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: -5, max: 20, temp: 0 }, // Negative HP
        ac: 15,
        speed: 30,
        conditions: [],
        turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'mon-1',
        sourceType: 'monster',
      };
      
      expect(isDead(monster)).toBe(true); // -5 <= 0
    });

    test('handles multiple incapacitating conditions', () => {
      const combatant: Combatant = {
        id: 'test',
        name: 'Test',
        type: 'pc',
        initiative: 10,
        dexterityModifier: 0,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 0, max: 20, temp: 0 },
        ac: 15,
        speed: 30,
        conditions: [{ name: 'Unconscious' }, { name: 'Paralyzed' }],
        turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'char-1',
        sourceType: 'character',
      };
      
      expect(isIncapacitated(combatant)).toBe(true);
      expect(canTakeReaction(combatant)).toBe(false);
    });
  });
});
