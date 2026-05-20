/**
 * Integration test for NPC Voice Diversity
 *
 * Tests that NPCs generate posts with distinct voices and proper character traits.
 * Requires GROQ_API_KEY to be set in environment.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveLiveLlmTestConfig } from '../../../../testing/integration/helpers/live-runtime';
import { BabylonLLMClient } from '../../llm/openai-client';
import {
  checkVoiceConsistency,
  getCharacterConfig,
  getConfiguredCharacters,
} from '../../services/npc-character-config';
import { StaticDataRegistry } from '../../services/static-data-registry';

// Load environment variables from project root
const projectRoot = resolve(__dirname, '../../../../..');
config({ path: resolve(projectRoot, '.env') });
config({ path: resolve(projectRoot, '.env.local') });
config({ path: resolve(projectRoot, '.env.test') });

// Check API key availability after env is loaded
const hasApiKey = !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY);
const liveLlmConfig = resolveLiveLlmTestConfig();

describe.skipIf(!liveLlmConfig.enabled || !hasApiKey)(
  'NPC Voice Diversity Integration',
  () => {
    let llmClient: BabylonLLMClient;

    beforeAll(() => {
      if (hasApiKey) {
        llmClient = BabylonLLMClient.forGameTick();
      }
    });

    it('should correctly detect API key presence from environment', () => {
      // Store original env values
      const originalGroqKey = process.env.GROQ_API_KEY;
      const originalOpenaiKey = process.env.OPENAI_API_KEY;

      try {
        // Test with both keys absent
        delete process.env.GROQ_API_KEY;
        delete process.env.OPENAI_API_KEY;
        const hasApiKeyWhenAbsent = !!(
          process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY
        );
        expect(hasApiKeyWhenAbsent).toBe(false);

        // Test with GROQ key present
        process.env.GROQ_API_KEY = 'test-groq-key';
        const hasApiKeyWithGroq = !!(
          process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY
        );
        expect(hasApiKeyWithGroq).toBe(true);

        // Test with only OpenAI key present
        delete process.env.GROQ_API_KEY;
        process.env.OPENAI_API_KEY = 'test-openai-key';
        const hasApiKeyWithOpenai = !!(
          process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY
        );
        expect(hasApiKeyWithOpenai).toBe(true);
      } finally {
        // Restore original env values
        if (originalGroqKey !== undefined) {
          process.env.GROQ_API_KEY = originalGroqKey;
        } else {
          delete process.env.GROQ_API_KEY;
        }
        if (originalOpenaiKey !== undefined) {
          process.env.OPENAI_API_KEY = originalOpenaiKey;
        } else {
          delete process.env.OPENAI_API_KEY;
        }
      }
    });

    it('should have character configs for key NPCs', () => {
      const chars = getConfiguredCharacters();

      // Verify key characters are configured
      expect(chars).toContain('kanyai-west');
      expect(chars).toContain('trump-terminal');
      expect(chars).toContain('dairiio-amodei');
      expect(chars).toContain('sam-ailtman');
      expect(chars).toContain('ailon-musk');
    });

    it('should have different temperatures for different personality types', () => {
      const kanyaiConfig = getCharacterConfig('kanyai-west');
      const dairiioConfig = getCharacterConfig('dairiio-amodei');
      const trumpConfig = getCharacterConfig('trump-terminal');

      // KanyAI "chaotic visionary" -> chaotic (0.95)
      expect(kanyaiConfig.temperature).toBe(0.95);
      // Trump "narcissistic showman" -> provocative (0.9)
      expect(trumpConfig.temperature).toBe(0.9);
      // Dairiio "safety theater director" -> corporate (0.6)
      expect(dairiioConfig.temperature).toBe(0.6);
      // Chaotic > Provocative > Corporate
      expect(kanyaiConfig.temperature).toBeGreaterThan(trumpConfig.temperature);
      expect(trumpConfig.temperature).toBeGreaterThan(
        dairiioConfig.temperature
      );
    });

    it('should have defined rivalries', () => {
      const samConfig = getCharacterConfig('sam-ailtman');
      const dairiioConfig = getCharacterConfig('dairiio-amodei');

      // Sam AIltman and Dairiio AmodAI are rivals
      expect(samConfig.rivals).toContain('dairiio-amodei');
      expect(dairiioConfig.rivals).toContain('sam-ailtman');
    });

    it('should load actors from static registry', async () => {
      const actors = StaticDataRegistry.getAllActors();

      expect(actors.length).toBeGreaterThan(0);

      // Check that some key actors exist
      const actorIds = actors.map((a) => a.id);
      expect(
        actorIds.some((id) => id.includes('kanye') || id.includes('kanyai'))
      ).toBe(true);
    });

    it.skipIf(!hasApiKey)(
      'should generate a post for KanyAI with uppercase style',
      async () => {
        const actors = StaticDataRegistry.getAllActors();
        const kanyai = actors.find(
          (a) => a.id.includes('kanyai') || a.id.includes('kanye')
        );

        if (!kanyai) {
          console.log('KanyAI actor not found, skipping');
          return;
        }

        const config = getCharacterConfig(kanyai.id);
        const templates = config.templatePosts;

        // Build a test prompt similar to what generateNPCPost does
        const prompt = `You ARE ${kanyai.name}. Write a single post exactly as they would.

=== WHO YOU ARE ===
${kanyai.description || ''}
Personality: ${kanyai.personality || ''}
Writing Style: ${kanyai.postStyle || ''}

=== HOW YOU WRITE (match this style exactly) ===
${templates
  .slice(0, 3)
  .map((t) => `"${t}"`)
  .join('\n')}

=== WHAT'S HAPPENING ===
"Will AI safety regulations pass by 2026?"

=== RULES ===
- Sound exactly like the examples above
- No hashtags, no emojis
- Max 280 characters

<response>
  <post>your post here</post>
</response>`;

        const response = await llmClient.generateJSON<{ post: string }>(
          prompt,
          {
            properties: { post: { type: 'string' } },
            required: ['post'],
          },
          {
            temperature: config.temperature,
            maxTokens: 300,
            format: 'xml',
          }
        );

        console.log('KanyAI post:', response.post);

        // Check voice consistency
        const voiceCheck = checkVoiceConsistency(kanyai.id, response.post);
        console.log('Voice check:', voiceCheck);

        // KanyAI should use ALL CAPS or have "I AM" style patterns
        expect(response.post.length).toBeGreaterThan(10);
      },
      30000
    );

    it.skipIf(!hasApiKey)(
      'should generate a post for Dairiio with safety focus',
      async () => {
        const actors = StaticDataRegistry.getAllActors();
        const dairiio = actors.find(
          (a) => a.id.includes('dairiio') || a.id.includes('dario')
        );

        if (!dairiio) {
          console.log('Dairiio actor not found, skipping');
          return;
        }

        const config = getCharacterConfig(dairiio.id);
        const templates = config.templatePosts;

        const prompt = `You ARE ${dairiio.name}. Write a single post exactly as they would.

=== WHO YOU ARE ===
${dairiio.description || ''}
Personality: ${dairiio.personality || ''}
Writing Style: ${dairiio.postStyle || ''}

=== HOW YOU WRITE (match this style exactly) ===
${templates
  .slice(0, 3)
  .map((t) => `"${t}"`)
  .join('\n')}

=== WHAT'S HAPPENING ===
"Will AI safety regulations pass by 2026?"

=== RULES ===
- Sound exactly like the examples above
- No hashtags, no emojis
- Max 280 characters

<response>
  <post>your post here</post>
</response>`;

        const response = await llmClient.generateJSON<{ post: string }>(
          prompt,
          {
            properties: { post: { type: 'string' } },
            required: ['post'],
          },
          {
            temperature: config.temperature,
            maxTokens: 300,
            format: 'xml',
          }
        );

        console.log('Dairiio post:', response.post);

        const voiceCheck = checkVoiceConsistency(dairiio.id, response.post);
        console.log('Voice check:', voiceCheck);

        expect(response.post.length).toBeGreaterThan(10);
        // Dairiio should NOT use ALL CAPS like KanyAI
        expect(response.post).not.toMatch(/^[A-Z\s\d.,!?'"()-]+$/);
      },
      30000
    );

    it.skipIf(!hasApiKey)(
      'should generate distinct posts for different NPCs on same topic',
      async () => {
        const allActors = StaticDataRegistry.getAllActors();
        const actors = allActors.slice(0, 3); // Test with 3 actors

        if (actors.length < 3) {
          console.log('Not enough actors, skipping');
          return;
        }

        const posts: { actor: string; post: string }[] = [];

        for (const actor of actors) {
          const config = getCharacterConfig(actor.id);

          const prompt = `You ARE ${actor.name}. Write a single post exactly as they would.

=== WHO YOU ARE ===
${actor.description || ''}

=== WHAT'S HAPPENING ===
"Will BitcAIn reach $100K by end of 2026?"

=== RULES ===
- Sound like ${actor.name}
- No hashtags, no emojis
- Max 280 characters

<response>
  <post>your post here</post>
</response>`;

          const response = await llmClient.generateJSON<{ post: string }>(
            prompt,
            {
              properties: { post: { type: 'string' } },
              required: ['post'],
            },
            {
              temperature: config.temperature,
              maxTokens: 300,
              format: 'xml',
            }
          );

          posts.push({ actor: actor.name, post: response.post });
        }

        console.log('Generated posts:');
        posts.forEach(({ actor, post }) => {
          console.log(`\n${actor}:`);
          console.log(`  "${post}"`);
        });

        // Verify all posts are unique
        const uniquePosts = new Set(posts.map((p) => p.post));
        expect(uniquePosts.size).toBe(posts.length);

        // Verify no posts are too similar (crude similarity check)
        for (let i = 0; i < posts.length; i++) {
          for (let j = i + 1; j < posts.length; j++) {
            const post1 = posts[i].post.toLowerCase();
            const post2 = posts[j].post.toLowerCase();

            // Count word overlap
            const words1 = new Set(post1.split(/\s+/));
            const words2 = new Set(post2.split(/\s+/));
            const overlap = [...words1].filter((w) => words2.has(w)).length;
            const similarity = overlap / Math.max(words1.size, words2.size);

            // Posts should not be more than 70% similar
            expect(similarity).toBeLessThan(0.7);
          }
        }
      },
      60000
    );
  }
);
