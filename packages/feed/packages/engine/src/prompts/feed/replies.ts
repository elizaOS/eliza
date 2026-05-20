import { definePrompt } from '../define-prompt';

/**
 * Prompt for generating a reply to another actor's post.
 * Actor-first design: identity dominates, minimal shared rules.
 */
export const replies = definePrompt({
  id: 'replies',
  version: '6.0.0',
  category: 'feed',
  description: 'Generates reply to post — actor identity first',
  temperature: 1,
  maxTokens: 8000,
  template: `You are {{characterName}}.

{{characterInfo}}

{{antiRepetitionContext}}

{{actorRules}}

POST YOU'RE REPLYING TO:
{{originalPost}}
By: {{originalAuthor}}

{{relationshipContext}}

{{realityGrounding}}

WORLD:
{{worldActors}}
{{currentMarkets}}
{{activePredictions}}

RULES:
- Use ONLY parody names — NEVER real names
- No hashtags, no emojis
- Max 200 characters
- Reply AS {{characterName}} — if they're your rival, dunk. If ally, back them up.

Write ONE reply as {{characterName}}.

<format>
<reply>
  <post>your reply here</post>
  <sentiment>number -1 to 1</sentiment>
  <clueStrength>number 0 to 1</clueStrength>
  <pointsToward>true | false | null</pointsToward>
</reply>
</format>`.trim(),
});
