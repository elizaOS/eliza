/**
 * AI DM Integration Test
 * Tests the real DM agent with actual OpenAI API calls.
 * Requires OPENAI_API_KEY in .env or environment.
 * 
 * This test creates a real AgentRuntime with the OpenAI plugin,
 * loads the DM character, and generates actual DM narration.
 */

import 'dotenv/config';
import { describe, test, expect, beforeAll } from 'bun:test';

// Check if we have an API key before even importing heavy deps
const HAS_API_KEY = !!process.env.OPENAI_API_KEY?.trim();

// We need to conditionally import these so tests don't fail at parse time
let AgentRuntime: typeof import('@elizaos/core').AgentRuntime;
let ModelType: typeof import('@elizaos/core').ModelType;
let dmCharacter: typeof import('../agents/dm-agent').dmCharacter;
let openaiPlugin: typeof import('@elizaos/plugin-openai').openaiPlugin;

if (HAS_API_KEY) {
  const core = await import('@elizaos/core');
  AgentRuntime = core.AgentRuntime;
  ModelType = core.ModelType;

  const dmMod = await import('../agents/dm-agent');
  dmCharacter = dmMod.dmCharacter;

  const oaiMod = await import('@elizaos/plugin-openai');
  openaiPlugin = oaiMod.openaiPlugin ?? oaiMod.default;
}

describe('AI Dungeon Master Integration', () => {
  // Skip all tests if no API key
  const describeAI = HAS_API_KEY ? describe : describe.skip;

  describeAI('with real OpenAI API', () => {
    let runtime: InstanceType<typeof AgentRuntime>;

    beforeAll(async () => {
      console.log('🤖 Creating real DM AgentRuntime with OpenAI...');

      let sqlPlugin;
      try {
        const sqlMod = await import('@elizaos/plugin-sql');
        sqlPlugin = sqlMod.default;
      } catch {
        // OK without it
      }

      const plugins = [openaiPlugin];
      if (sqlPlugin) plugins.push(sqlPlugin);

      const character = {
        ...dmCharacter,
        settings: {
          ...dmCharacter.settings,
          secrets: {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
          },
        },
      };

      runtime = new AgentRuntime({
        character,
        plugins,
        logLevel: 'warn',
      });
      await runtime.initialize();
      console.log('✅ DM AgentRuntime initialized');
    }, 30000); // 30s timeout for initialization

    test('runtime has generateText method', () => {
      expect(typeof runtime.generateText).toBe('function');
    });

    test('runtime has useModel method', () => {
      expect(typeof runtime.useModel).toBe('function');
    });

    test('DM can narrate a scene', async () => {
      const result = await runtime.generateText(
        `You are the Dungeon Master. The party has just entered a dark cave. ` +
        `Describe what they see in 2-3 sentences. Be vivid and atmospheric.`,
        { maxTokens: 200, temperature: 0.7, stopSequences: [] },
      );

      console.log('\n📖 DM Narration:', result.text, '\n');

      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(20);
    }, 30000);

    test('DM can respond to a player action', async () => {
      const prompt = `You are the Dungeon Master for a D&D 5e campaign.

## Current Scene
Location: Millbrook Village - The Rusty Tankard Inn
A cozy inn where travelers rest and locals share news. A fire crackles in the hearth.
Time: evening
Party: Thordak (L1 Dwarf Fighter, 12/12 HP), Lyria (L1 Elf Wizard, 7/7 HP)

## Player Action
Thordak: "I approach the innkeeper and ask about the goblin attacks."
Action type: social

Respond as the DM. Be vivid, concise (2-4 sentences), and roleplay the innkeeper. 
Give the innkeeper a distinct personality.`;

      const result = await runtime.generateText(prompt, {
        maxTokens: 300,
        temperature: 0.8,
        stopSequences: [],
      });

      console.log('\n🎭 DM Response to social action:', result.text, '\n');

      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(30);
      // Should be roleplaying, not meta-commentary
      expect(result.text.toLowerCase()).not.toContain('as the dm');
    }, 30000);

    test('DM can describe exploration', async () => {
      const prompt = `You are the Dungeon Master for a D&D 5e campaign.

## Current Scene
Location: The Forest Road
A winding dirt road through Briarwood Forest. Ancient oaks tower overhead.
Time: midday
Party: Whisper (L1 Halfling Rogue, 9/9 HP)

## Player Action
Whisper: "I search the overturned merchant cart for any clues about what attacked it."
Action type: investigate

Respond as the DM. Describe what Whisper finds. If appropriate, ask for a skill check.
Keep it to 2-4 sentences.`;

      const result = await runtime.generateText(prompt, {
        maxTokens: 250,
        temperature: 0.8,
        stopSequences: [],
      });

      console.log('\n🔍 DM Response to investigation:', result.text, '\n');

      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(20);
    }, 30000);

    test('DM can narrate combat action', async () => {
      const prompt = `You are the Dungeon Master for a D&D 5e campaign.

## Combat - Round 2
Location: The Goblin Den entrance
Thordak rolled 18 to hit (AC 15) - HIT! Deals 11 slashing damage to Goblin Sentry 1.
Goblin Sentry 1 had 7 HP, now at 0 HP - defeated!

Narrate this attack cinematically in 2-3 sentences. Describe the weapon strike and the goblin falling.`;

      const result = await runtime.generateText(prompt, {
        maxTokens: 200,
        temperature: 0.9,
        stopSequences: [],
      });

      console.log('\n⚔️ DM Combat narration:', result.text, '\n');

      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(20);
    }, 30000);

    test('DM uses game context from the full character definition', async () => {
      // This tests that the character's system prompt, bio, and style are applied
      const result = await runtime.generateText(
        `The party asks you to describe what happens next after they defeated the goblins ` +
        `and found a mysterious amulet glowing with purple light.`,
        { maxTokens: 250, temperature: 0.8, stopSequences: [], includeCharacter: true },
      );

      console.log('\n🔮 DM with full character context:', result.text, '\n');

      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(30);
    }, 30000);
  });

  // This test always runs — verifies the fallback path
  describe('without API key (fallback)', () => {
    test('buildTemplateResponse works for all action types', async () => {
      // Import the orchestrator functions for template testing
      const { processPlayerAction, createGameOrchestrator, transitionPhase } = await import('../campaign/game-orchestrator');

      // Mock the persistence layer
      const { mock } = await import('bun:test');
      mock.module('../persistence', () => ({
        characterRepository: { getByCampaign: async () => [], updateHP: async () => {}, updateSheet: async () => {}, getById: async () => null, addMemory: async () => ({ id: 'm' }) },
        locationRepository: { getById: async () => ({ name: 'Test Village', description: 'A quiet village.' }), recordVisit: async () => {}, recordInteraction: async () => {} },
        campaignRepository: {},
        worldRepository: { createEvent: async () => ({ id: 'e' }), logCombatAction: async () => {} },
      }));
      mock.module('../campaign/memory-retrieval', () => ({ storeCharacterMemory: async () => {} }));

      const state = createGameOrchestrator();
      state.sessionState = {
        sessionId: 's', campaignId: 'c', startedAt: new Date(),
        currentTime: { year: 1490, month: 3, day: 15, hour: 14, minute: 0 },
        currentLocationId: 'loc', partyMembers: ['char-1'], activeQuests: [],
        recentEvents: [], combatEncounters: 0, npcsInteracted: [],
        locationsVisited: ['loc'], lootGained: [], experienceGained: 0,
      };
      state.phase = 'exploration';
      state._characters = [{ id: 'char-1', name: 'Tester', race: 'Human', class: 'Fighter', level: 1,
        abilities: { strength: { score: 10, modifier: 0 }, dexterity: { score: 10, modifier: 0 },
          constitution: { score: 10, modifier: 0 }, intelligence: { score: 10, modifier: 0 },
          wisdom: { score: 10, modifier: 0 }, charisma: { score: 10, modifier: 0 } } }];
      state.playerAgents.set('char-1', { setSetting: () => {}, getSetting: () => null, emit: () => {} } as never);
      // DM agent without generateText — forces template fallback
      state.dmAgent = { setSetting: () => {}, getSetting: () => null, emit: () => {} } as never;

      const result = await processPlayerAction(state, 'char-1', { type: 'explore', description: 'look around' });
      expect(result.success).toBe(true);
      expect(result.response).toContain('Tester');
    });
  });
});
