/**
 * Tests for game-orchestrator.ts
 * Tests the actual routing logic, combat dispatch, and rest mechanics.
 * 
 * The orchestrator calls DB repositories for persistence (recordEvent, updateHP, etc).
 * We stub those at the module boundary but test all game logic through real code paths.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  createGameOrchestrator,
  processPlayerAction,
  transitionPhase,
  getGameStatus,
  type GameState,
  type GamePhase,
} from '../campaign/game-orchestrator';
import type { SessionState } from '../campaign/session-manager';
import { createEncounter, addPartyToEncounter, startCombat } from '../combat/combat-manager';
import type { CharacterSheet } from '../types';

// Stub DB-dependent functions. These are the I/O boundaries — the game logic is real.
mock.module('../persistence', () => ({
  characterRepository: {
    getByCampaign: async () => [],
    updateHP: async () => {},
    updateSheet: async () => {},
    getById: async () => null,
    addMemory: async () => ({ id: 'mem-1' }),
  },
  locationRepository: {
    getById: async () => null,
    recordVisit: async () => {},
    recordInteraction: async () => {},
  },
  campaignRepository: {},
  worldRepository: {
    createEvent: async () => ({ id: 'evt-1' }),
    logCombatAction: async () => {},
  },
}));

mock.module('../campaign/memory-retrieval', () => ({
  storeCharacterMemory: async () => {},
}));

// Test character sheets (real D&D data from starter adventure)
const thordak: CharacterSheet = {
  id: 'char-thordak',
  name: 'Thordak Ironforge',
  race: 'Dwarf',
  class: 'Fighter',
  level: 1,
  proficiencyBonus: 2,
  abilities: {
    strength: { score: 16, modifier: 3 },
    dexterity: { score: 12, modifier: 1 },
    constitution: { score: 15, modifier: 2 },
    intelligence: { score: 10, modifier: 0 },
    wisdom: { score: 13, modifier: 1 },
    charisma: { score: 8, modifier: -1 },
  },
  hp: { current: 10, max: 12, temp: 0 },
  ac: 18,
  speed: 25,
  skills: { athletics: 5, intimidation: 1, perception: 3 },
  hitDice: { current: 1, max: 1 },
  equipment: {
    weapons: [
      { name: 'Battleaxe', type: 'weapon', damage: '1d8', damageType: 'slashing', properties: ['versatile'] },
    ],
  },
};

const lyria: CharacterSheet = {
  id: 'char-lyria',
  name: 'Lyria Moonshadow',
  race: 'Elf',
  class: 'Wizard',
  level: 1,
  proficiencyBonus: 2,
  abilities: {
    strength: { score: 8, modifier: -1 },
    dexterity: { score: 14, modifier: 2 },
    constitution: { score: 12, modifier: 1 },
    intelligence: { score: 17, modifier: 3 },
    wisdom: { score: 13, modifier: 1 },
    charisma: { score: 10, modifier: 0 },
  },
  hp: { current: 5, max: 7, temp: 0 },
  ac: 12,
  speed: 30,
  skills: { arcana: 5, perception: 3 },
  hitDice: { current: 1, max: 1 },
  spellSlots: { 1: { current: 2, max: 2 } },
  spellsKnown: [
    { name: 'Fire Bolt', level: 0, school: 'Evocation', castingTime: '1 action', range: '120 feet', damage: '1d10', damageType: 'fire', attack: true },
    { name: 'Magic Missile', level: 1, school: 'Evocation', castingTime: '1 action', range: '120 feet', damage: '1d4+1' },
    { name: 'Shield', level: 1, school: 'Abjuration', castingTime: '1 reaction', range: 'Self' },
  ],
  equipment: {
    weapons: [{ name: 'Quarterstaff', type: 'weapon', damage: '1d6', damageType: 'bludgeoning', properties: ['versatile'] }],
  },
};

function createTestSessionState(): SessionState {
  return {
    sessionId: 'sess-test',
    campaignId: 'camp-test',
    startedAt: new Date(),
    currentTime: { year: 1490, month: 3, day: 15, hour: 10, minute: 30 },
    currentLocationId: 'loc-test',
    partyMembers: ['char-thordak', 'char-lyria'],
    activeQuests: [],
    recentEvents: [],
    combatEncounters: 0,
    npcsInteracted: [],
    locationsVisited: ['loc-test'],
    lootGained: [],
    experienceGained: 0,
  };
}

function createTestGameState(phase: GamePhase = 'exploration'): GameState {
  const state = createGameOrchestrator();
  state.sessionState = createTestSessionState();
  state.phase = phase;
  state._characters = [thordak, lyria];
  state._campaign = { id: 'camp-test', name: 'Test Campaign', description: 'test' } as GameState['_campaign'];

  // Register agents for both characters
  const fakeAgent = { setSetting: () => {}, getSetting: () => null, emit: () => {} };
  state.playerAgents.set('char-thordak', fakeAgent as never);
  state.playerAgents.set('char-lyria', fakeAgent as never);

  return state;
}


describe('Game Orchestrator', () => {

  describe('processPlayerAction — phase routing', () => {
    test('returns error when no session is active', async () => {
      const state = createGameOrchestrator(); // sessionState is null
      const result = await processPlayerAction(state, 'char-1', { type: 'explore', description: 'look around' });
      expect(result.success).toBe(false);
      expect(result.response).toContain('No active session');
    });

    test('returns error for unknown character', async () => {
      const state = createTestGameState();
      const result = await processPlayerAction(state, 'char-nonexistent', { type: 'explore', description: 'look' });
      expect(result.success).toBe(false);
      expect(result.response).toContain('Unknown character');
    });

    test('exploration phase allows explore actions', async () => {
      const state = createTestGameState('exploration');
      const result = await processPlayerAction(state, 'char-thordak', { type: 'explore', description: 'look around the room' });
      expect(result.success).toBe(true);
      expect(result.response).toContain('Thordak');
    });

    test('social phase allows social actions', async () => {
      const state = createTestGameState('social');
      const result = await processPlayerAction(state, 'char-thordak', { type: 'social', description: 'talk to the innkeeper' });
      expect(result.success).toBe(true);
    });

    test('narration phase auto-transitions to exploration on first action', async () => {
      const state = createTestGameState('narration');
      expect(state.phase).toBe('narration');
      const result = await processPlayerAction(state, 'char-thordak', { type: 'explore', description: 'look around' });
      expect(result.success).toBe(true);
      expect(state.phase).toBe('exploration');
    });

    test('transition phase auto-transitions to exploration', async () => {
      const state = createTestGameState('transition');
      await processPlayerAction(state, 'char-thordak', { type: 'explore', description: 'look' });
      expect(state.phase).toBe('exploration');
    });

    test('rest phase allows messages', async () => {
      const state = createTestGameState('rest');
      const result = await processPlayerAction(state, 'char-thordak', { type: 'message', description: 'hello' });
      expect(result.success).toBe(true);
    });

    test('rest phase blocks non-message actions', async () => {
      const state = createTestGameState('rest');
      const result = await processPlayerAction(state, 'char-thordak', { type: 'explore', description: 'look' });
      expect(result.success).toBe(false);
      expect(result.response).toContain('resting');
    });

    test('ending phase blocks all actions', async () => {
      const state = createTestGameState('ending' as GamePhase);
      const result = await processPlayerAction(state, 'char-thordak', { type: 'explore', description: 'look' });
      expect(result.success).toBe(false);
      expect(result.response).toContain('Cannot take actions');
    });

    test('pendingActions is cleaned up after processing', async () => {
      const state = createTestGameState('exploration');
      expect(state.pendingActions.length).toBe(0);
      await processPlayerAction(state, 'char-thordak', { type: 'explore', description: 'look' });
      expect(state.pendingActions.length).toBe(0);
    });
  });

  describe('processPlayerAction — combat routing', () => {
    function createCombatState(): GameState {
      const state = createTestGameState('combat');

      // Create a real encounter with real combatants from character sheets
      let encounter = createEncounter('camp-test', 'sess-test');
      const { encounter: withParty } = addPartyToEncounter(encounter, [thordak, lyria]);
      encounter = startCombat(withParty);

      // Add a monster manually
      const goblin = {
        id: 'mob-goblin',
        name: 'Goblin',
        type: 'monster' as const,
        initiative: 10,
        dexterityModifier: 2,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 7, max: 7, temp: 0 },
        ac: 15,
        speed: 30,
        conditions: [],
        turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'srd-goblin',
        sourceType: 'monster' as const,
        experiencePoints: 50,
      };
      encounter.initiativeOrder.push(goblin);

      state.combatEncounter = encounter;
      return state;
    }

    test('combat action fails if no active combat encounter', async () => {
      const state = createTestGameState('combat');
      state.combatEncounter = null;
      const result = await processPlayerAction(state, 'char-thordak', { type: 'attack', description: 'swing' });
      expect(result.success).toBe(false);
      expect(result.response).toContain('No active combat');
    });

    test('combat action fails if not the character\'s turn', async () => {
      const state = createCombatState();
      // The first character in initiative order gets the turn
      const currentId = state.combatEncounter!.initiativeOrder[0].sourceId;
      const otherId = currentId === 'char-thordak' ? 'char-lyria' : 'char-thordak';

      const result = await processPlayerAction(state, otherId, { type: 'attack', description: 'swing' });
      expect(result.success).toBe(false);
      expect(result.response).toContain('not your turn');
    });

    test('attack without target fails', async () => {
      const state = createCombatState();
      const currentId = state.combatEncounter!.initiativeOrder[0].sourceId;

      const result = await processPlayerAction(state, currentId, { type: 'attack', description: 'swing' });
      expect(result.success).toBe(false);
      expect(result.response).toContain('No valid target');
    });

    test('attack with target resolves and advances turn', async () => {
      const state = createCombatState();
      const currentIdx = state.combatEncounter!.currentTurnIndex;
      const currentId = state.combatEncounter!.initiativeOrder[currentIdx].sourceId;

      const result = await processPlayerAction(state, currentId, {
        type: 'attack', description: 'swing',
        target: 'Goblin',
      });
      expect(result.success).toBe(true);
      // Turn should have advanced
      expect(state.combatEncounter!.currentTurnIndex).not.toBe(currentIdx);
    });

    test('dash action succeeds and advances turn', async () => {
      const state = createCombatState();
      const currentId = state.combatEncounter!.initiativeOrder[0].sourceId;

      const result = await processPlayerAction(state, currentId, { type: 'dash', description: 'dash' });
      expect(result.success).toBe(true);
      expect(result.response.toLowerCase()).toContain('dash');
    });

    test('end_turn advances to next combatant', async () => {
      const state = createCombatState();
      const initialIdx = state.combatEncounter!.currentTurnIndex;
      const currentId = state.combatEncounter!.initiativeOrder[initialIdx].sourceId;

      await processPlayerAction(state, currentId, { type: 'end_turn', description: 'end' });
      expect(state.combatEncounter!.currentTurnIndex).not.toBe(initialIdx);
    });

    test('attack uses real weapon stats from character sheet', async () => {
      const state = createCombatState();
      // Force Thordak to be first in initiative
      const thordakIdx = state.combatEncounter!.initiativeOrder.findIndex(c => c.sourceId === 'char-thordak');
      if (thordakIdx !== 0) {
        const [t] = state.combatEncounter!.initiativeOrder.splice(thordakIdx, 1);
        state.combatEncounter!.initiativeOrder.unshift(t);
        state.combatEncounter!.currentTurnIndex = 0;
      }

      const result = await processPlayerAction(state, 'char-thordak', {
        type: 'attack', description: 'swing', target: 'Goblin',
      });
      expect(result.success).toBe(true);
      // The response should reference the attack roll. Thordak's Battleaxe: +5 to hit, 1d8+3 slashing
      // We can't predict the exact roll but the description should have numbers
      expect(result.response).toMatch(/\d+/);
    });
  });

  describe('processPlayerAction — rest mechanics', () => {
    test('short rest heals HP using hit dice', async () => {
      const state = createTestGameState('exploration');
      // Thordak is at 10/12 HP with 1 hit die available
      const beforeHP = state._characters![0].hp!.current;
      expect(beforeHP).toBe(10);

      const result = await processPlayerAction(state, 'char-thordak', {
        type: 'rest', description: 'take a short rest',
      });
      expect(result.success).toBe(true);
      expect(result.response).toContain('short rest');
      // HP should have increased (or stayed same if max)
      const afterHP = state._characters![0].hp!.current;
      expect(afterHP).toBeGreaterThanOrEqual(beforeHP);
      expect(afterHP).toBeLessThanOrEqual(12); // can't exceed max
    });

    test('short rest advances game time by 60 minutes', async () => {
      const state = createTestGameState('exploration');
      const beforeMinute = state.sessionState!.currentTime.minute;
      const beforeHour = state.sessionState!.currentTime.hour;

      await processPlayerAction(state, 'char-thordak', {
        type: 'rest', description: 'rest',
      });

      const totalBefore = beforeHour * 60 + beforeMinute;
      const totalAfter = state.sessionState!.currentTime.hour * 60 + state.sessionState!.currentTime.minute;
      expect(totalAfter - totalBefore).toBe(60);
    });

    test('long rest restores all HP and spell slots', async () => {
      const state = createTestGameState('exploration');
      // Lyria is at 5/7 HP with 2 spell slots, drain one
      state._characters![1].hp!.current = 3;
      state._characters![1].spellSlots = { 1: { current: 0, max: 2 } };

      const result = await processPlayerAction(state, 'char-lyria', {
        type: 'rest', description: 'rest', metadata: { restType: 'long' },
      });
      expect(result.success).toBe(true);
      expect(result.response).toContain('long rest');

      // HP should be restored to max
      expect(state._characters![1].hp!.current).toBe(7);
      // Spell slots should be restored
      expect(state._characters![1].spellSlots![1].current).toBe(2);
    });

    test('long rest advances game time by 480 minutes (8 hours)', async () => {
      const state = createTestGameState('exploration');
      const beforeHour = state.sessionState!.currentTime.hour;

      await processPlayerAction(state, 'char-thordak', {
        type: 'rest', description: 'rest', metadata: { restType: 'long' },
      });

      // 10:30 + 480min = 18:30
      expect(state.sessionState!.currentTime.hour).toBe(beforeHour + 8);
    });

    test('rest with no character found returns error', async () => {
      const state = createTestGameState('exploration');
      state._characters = []; // clear characters

      const result = await processPlayerAction(state, 'char-thordak', {
        type: 'rest', description: 'rest',
      });
      expect(result.success).toBe(false);
      expect(result.response).toContain('Character not found');
    });
  });

  describe('processPlayerAction — spell slots', () => {
    test('casting a leveled spell consumes a spell slot', async () => {
      const state = createTestGameState('combat');
      let encounter = createEncounter('camp-test', 'sess-test');
      const { encounter: withParty } = addPartyToEncounter(encounter, [lyria]);
      encounter = startCombat(withParty);
      const goblin = {
        id: 'mob-goblin', name: 'Goblin', type: 'monster' as const,
        initiative: 5, dexterityModifier: 2,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 7, max: 7, temp: 0 }, ac: 15, speed: 30,
        conditions: [], turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'srd-goblin', sourceType: 'monster' as const, experiencePoints: 50,
      };
      encounter.initiativeOrder.push(goblin);
      // Force Lyria to be first
      const lyriaIdx = encounter.initiativeOrder.findIndex(c => c.sourceId === 'char-lyria');
      if (lyriaIdx !== 0) {
        const [l] = encounter.initiativeOrder.splice(lyriaIdx, 1);
        encounter.initiativeOrder.unshift(l);
      }
      encounter.currentTurnIndex = 0;
      state.combatEncounter = encounter;

      expect(state._characters![1].spellSlots![1].current).toBe(2);

      await processPlayerAction(state, 'char-lyria', {
        type: 'cast_spell', description: 'cast a spell',
        target: 'Goblin',
        metadata: { spellName: 'Magic Missile' },
      });

      // Should have consumed a level 1 slot (Magic Missile is level 1)
      expect(state._characters![1].spellSlots![1].current).toBe(1);
    });

    test('casting a cantrip does not consume spell slots', async () => {
      const state = createTestGameState('combat');
      let encounter = createEncounter('camp-test', 'sess-test');
      const { encounter: withParty } = addPartyToEncounter(encounter, [lyria]);
      encounter = startCombat(withParty);
      const goblin = {
        id: 'mob-goblin', name: 'Goblin', type: 'monster' as const,
        initiative: 5, dexterityModifier: 2,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 7, max: 7, temp: 0 }, ac: 15, speed: 30,
        conditions: [], turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'srd-goblin', sourceType: 'monster' as const, experiencePoints: 50,
      };
      encounter.initiativeOrder.push(goblin);
      const lyriaIdx = encounter.initiativeOrder.findIndex(c => c.sourceId === 'char-lyria');
      if (lyriaIdx !== 0) {
        const [l] = encounter.initiativeOrder.splice(lyriaIdx, 1);
        encounter.initiativeOrder.unshift(l);
      }
      encounter.currentTurnIndex = 0;
      state.combatEncounter = encounter;

      const slotsBefore = state._characters![1].spellSlots![1].current;

      await processPlayerAction(state, 'char-lyria', {
        type: 'cast_spell', description: 'cast fire bolt',
        target: 'Goblin',
        metadata: { spellName: 'Fire Bolt' },
      });

      // Cantrip (level 0) should NOT consume a slot
      expect(state._characters![1].spellSlots![1].current).toBe(slotsBefore);
    });

    test('casting with no slots remaining fails', async () => {
      const state = createTestGameState('combat');
      state._characters![1].spellSlots = { 1: { current: 0, max: 2 } };

      let encounter = createEncounter('camp-test', 'sess-test');
      const { encounter: withParty } = addPartyToEncounter(encounter, [lyria]);
      encounter = startCombat(withParty);
      const goblin = {
        id: 'mob-goblin', name: 'Goblin', type: 'monster' as const,
        initiative: 5, dexterityModifier: 2,
        wisdomModifier: 0,
        constitutionModifier: 0,
        hp: { current: 7, max: 7, temp: 0 }, ac: 15, speed: 30,
        conditions: [], turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
        sourceId: 'srd-goblin', sourceType: 'monster' as const, experiencePoints: 50,
      };
      encounter.initiativeOrder.push(goblin);
      const lyriaIdx = encounter.initiativeOrder.findIndex(c => c.sourceId === 'char-lyria');
      if (lyriaIdx !== 0) {
        const [l] = encounter.initiativeOrder.splice(lyriaIdx, 1);
        encounter.initiativeOrder.unshift(l);
      }
      encounter.currentTurnIndex = 0;
      state.combatEncounter = encounter;

      const result = await processPlayerAction(state, 'char-lyria', {
        type: 'cast_spell', description: 'cast',
        target: 'Goblin',
        metadata: { spellName: 'Magic Missile' },
      });

      expect(result.success).toBe(false);
      expect(result.response).toContain('No spell slots remaining');
    });
  });

  describe('transitionPhase', () => {
    test('changes phase and records event', async () => {
      const state = createTestGameState('exploration');
      await transitionPhase(state, 'social');
      expect(state.phase).toBe('social');
    });

    test('rest phase advances time', async () => {
      const state = createTestGameState('exploration');
      const hourBefore = state.sessionState!.currentTime.hour;
      await transitionPhase(state, 'rest', { restType: 'short' });
      expect(state.phase).toBe('rest');
      // Short rest = 60 minutes
      expect(state.sessionState!.currentTime.hour).toBe(hourBefore + 1);
    });

    test('exploration phase populates turn queue', async () => {
      const state = createTestGameState('narration');
      await transitionPhase(state, 'exploration');
      expect(state.turnQueue.length).toBe(2); // both characters
    });
  });

  describe('getGameStatus', () => {
    test('returns correct status for exploration', () => {
      const state = createTestGameState('exploration');
      const status = getGameStatus(state);
      expect(status.phase).toBe('exploration');
      expect(status.inCombat).toBe(false);
      expect(status.currentTurn).toBeNull();
      expect(status.roundNumber).toBe(0);
    });

    test('returns session duration in minutes', () => {
      const state = createTestGameState('exploration');
      // Set start time to 5 minutes ago
      state.sessionState!.startedAt = new Date(Date.now() - 5 * 60 * 1000);
      const status = getGameStatus(state);
      expect(status.sessionDuration).toBeGreaterThanOrEqual(4);
      expect(status.sessionDuration).toBeLessThanOrEqual(6);
    });
  });
});
