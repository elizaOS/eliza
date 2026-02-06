/**
 * Game Bootstrap — loads campaign, creates DM agent runtime with OpenAI, starts session.
 */

import 'dotenv/config';
import type { Server as SocketIOServer } from 'socket.io';
import {
  AgentRuntime,
  type Character,
  type Plugin,
  stringToUuid,
} from '@elizaos/core';
import type { GameState } from './game-orchestrator';
import { startSession } from './session-manager';
import { campaignRepository, characterRepository } from '../persistence';
import { openingNarration } from '../content';
import { dmCharacter, dmPlugin } from '../agents/dm-agent';

/**
 * Dynamically load the LLM plugin based on available API keys.
 * Prefers OpenAI but falls back to others if available.
 */
async function loadLLMPlugin(): Promise<Plugin | null> {
  const providers = [
    { key: 'OPENAI_API_KEY', path: '@elizaos/plugin-openai', name: 'openaiPlugin' },
    { key: 'ANTHROPIC_API_KEY', path: '@elizaos/plugin-anthropic', name: 'anthropicPlugin' },
    { key: 'GOOGLE_GENERATIVE_AI_API_KEY', path: '@elizaos/plugin-google-genai', name: 'googleGenaiPlugin' },
  ];

  for (const p of providers) {
    if (process.env[p.key]?.trim()) {
      const mod = await import(p.path);
      const plugin = mod[p.name] ?? mod.default;
      if (plugin) {
        console.log(`✅ Using ${p.key.replace('_API_KEY', '')} for DM language model`);
        return plugin;
      }
    }
  }
  return null;
}

/**
 * Lightweight agent wrapper for player characters (no LLM needed).
 */
function createPlayerWrapper(name: string) {
  const settings = new Map<string, unknown>();
  return {
    agentId: crypto.randomUUID(),
    character: { name },
    setSetting: (k: string, v: unknown) => { settings.set(k, v); },
    getSetting: (k: string) => settings.get(k) ?? null,
    registerPlugin: () => {},
    emit: () => {},
  };
}

export async function bootstrapGame(
  gameState: GameState,
  io: SocketIOServer,
  campaignId?: string,
): Promise<void> {
  let campaign: Awaited<ReturnType<typeof campaignRepository.getById>>;

  if (campaignId) {
    campaign = await campaignRepository.getById(campaignId);
  } else {
    const campaigns = await campaignRepository.list();
    campaign = campaigns.find(c => c.status === 'active') ?? campaigns[0] ?? null;
  }

  if (!campaign || !campaign.id) {
    console.log('⚠️  No campaign found in database. Run `bun run seed` first.');
    return;
  }

  const cid = campaign.id;
  console.log(`📜 Loading campaign: ${campaign.name} (${cid})`);

  const characters = await characterRepository.getByCampaign(cid);
  if (characters.length === 0) {
    console.log('⚠️  No characters found for campaign. Run `bun run seed` first.');
    return;
  }

  const { session, state: sessionState } = await startSession(cid);
  console.log(`🎮 Session started: ${session.id}`);

  // Create the DM agent with a real AgentRuntime + LLM plugin
  const llmPlugin = await loadLLMPlugin();
  let dmAgent: GameState['dmAgent'];

  if (llmPlugin) {
    console.log('🤖 Creating AI Dungeon Master...');
    let sqlPlugin: Plugin | null = null;
    try {
      const sqlMod = await import('@elizaos/plugin-sql');
      sqlPlugin = sqlMod.default ?? (sqlMod as Record<string, Plugin>).plugin ?? null;
    } catch {
      console.log('⚠️  plugin-sql not available, DM agent will run without database adapter');
    }

    const plugins: Plugin[] = [llmPlugin, dmPlugin];
    if (sqlPlugin) plugins.push(sqlPlugin);

    const character: Character = {
      ...dmCharacter,
      settings: {
        ...dmCharacter.settings,
        secrets: {
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
          GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '',
        },
      },
    };

    const runtime = new AgentRuntime({
      character,
      plugins,
      logLevel: 'warn',
    });

    try {
      await runtime.initialize();
      console.log('✅ AI Dungeon Master initialized');
      dmAgent = runtime;
    } catch (error) {
      console.error('⚠️  Failed to initialize DM runtime:', error);
      console.log('⚠️  Falling back to template-based DM');
      dmAgent = createPlayerWrapper('Dungeon Master') as unknown as GameState['dmAgent'];
    }
  } else {
    console.log('⚠️  No LLM API key found. DM will use template responses.');
    console.log('   Set OPENAI_API_KEY in .env for AI-powered narration.');
    dmAgent = createPlayerWrapper('Dungeon Master') as unknown as GameState['dmAgent'];
  }

  // Player agents (lightweight — no LLM needed, game logic is in the orchestrator)
  const playerAgents = new Map<string, ReturnType<typeof createPlayerWrapper>>();
  for (const character of characters) {
    const charId = character.id;
    if (!charId) continue;
    const agent = createPlayerWrapper(character.name);
    agent.setSetting('role', 'player');
    agent.setSetting('campaignId', cid);
    agent.setSetting('sessionId', session.id);
    agent.setSetting('characterId', charId);
    agent.setSetting('characterSheet', character);
    playerAgents.set(charId, agent);
  }

  gameState.dmAgent = dmAgent;
  gameState.playerAgents = playerAgents as unknown as GameState['playerAgents'];
  gameState.sessionState = sessionState;
  gameState.phase = 'narration';
  gameState.lastUpdate = new Date();
  gameState._campaign = campaign;
  gameState._characters = characters;
  gameState._io = io;
  gameState._openingNarration = openingNarration;

  console.log(`✅ Game bootstrapped: ${characters.length} characters, phase=narration`);
}
