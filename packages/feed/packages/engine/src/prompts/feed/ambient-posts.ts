import { definePrompt } from '../define-prompt';

/**
 * Prompt for generating a single ambient post from an NPC actor.
 *
 * Design principles:
 * - Actor identity is 60%+ of the prompt (voice, examples, personality)
 * - Minimal shared rules (parody names, no hashtags — stated once)
 * - Context is compact and relevant (not a wall of optional sections)
 * - Per-actor rules injected (ignoreTopics, anti-repetition patterns)
 *
 * Called PER CHARACTER (not batched) with full character context.
 */
export const ambientPosts = definePrompt({
  id: 'ambient-posts',
  version: '6.0.0',
  category: 'feed',
  description: 'Generates ambient post — actor identity first, minimal rules',
  temperature: 1.1,
  maxTokens: 8000,
  template: `You are {{characterName}}.

{{characterInfo}}

{{antiRepetitionContext}}

{{actorRules}}

WHAT'S HAPPENING:
{{trendContext}}
{{progressContext}}
{{atmosphereContext}}
{{timeEnergy}}

{{realityGrounding}}

WORLD:
{{worldActors}}
{{currentMarkets}}
{{activePredictions}}

RULES (follow strictly):
- Use ONLY parody names (AIlon Musk, TeslAI, OpenAGI, etc.) — NEVER real names
- No hashtags, no emojis
- Max 200 characters
- Sound like YOUR examples above — a reader should know it's you without seeing your name
- Reference events, people, or markets naturally — don't force it

Write ONE post as {{characterName}}. Match your voice exactly.

<format>
<post>
  <content>your post here</content>
  <sentiment>number -1 to 1</sentiment>
  <clueStrength>number 0 to 1</clueStrength>
  <pointsToward>true | false | null</pointsToward>
</post>
</format>`.trim(),
});
