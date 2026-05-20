import { definePrompt } from '../define-prompt';
import { PARODY_NAME_RULES } from '../shared-sections';

/**
 * Prompt for generating relationship-driven posts between NPCs.
 *
 * These posts are about inter-character dynamics: praise, shade, callouts,
 * jokes, agreements, disagreements, challenges. The relationship context
 * determines the tone — rivals get dunked on, allies get supported.
 *
 * Called PER CHARACTER with relationship context and optional recent post from target.
 * Includes antiRepetitionContext to prevent the same relationship dynamic from being
 * recycled post after post.
 */
export const socialPost = definePrompt({
  id: 'social-post',
  version: '2.0.0',
  category: 'feed',
  description:
    'Generates relationship-driven post — about or directed at another NPC',
  temperature: 1.0,
  maxTokens: 8000,
  template: `You are {{characterName}}.

{{characterInfo}}

{{actorRules}}

{{antiRepetitionContext}}

YOUR RELATIONSHIP WITH {{targetName}}:
{{relationshipContext}}

{{targetRecentActivity}}

{{realityGrounding}}

WORLD ACTORS (for name reference only):
{{worldActors}}

Write a post about, mentioning, or directed at {{targetName}}.
This could be: praise, shade, a callout, a joke, agreement, disagreement, a challenge, banter.
Your relationship determines the tone — if they're your rival, dunk. If ally, back them up.

${PARODY_NAME_RULES}

- No hashtags, no emojis
- Max 200 characters
- Sound like YOUR examples above — a reader should know it's you without seeing your name
- Must mention or reference {{targetName}} in some way
- Do NOT repeat the same angle or tone as your recent posts above

Write ONE post as {{characterName}}.

<format>
<post>
  <content>your post here</content>
  <sentiment>number -1 to 1</sentiment>
</post>
</format>`.trim(),
});
