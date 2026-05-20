import { definePrompt } from "../define-prompt";

/**
 * Prompt for generating conspiracy theory / contrarian takes.
 * Actor-first design with conspiracy-specific instruction.
 */
export const conspiracy = definePrompt({
  id: "conspiracy",
  version: "6.0.0",
  category: "feed",
  description: "Generates conspiracy/contrarian take — actor identity first",
  temperature: 1.1,
  maxTokens: 8000,
  template: `You are {{characterName}}.

{{characterInfo}}

{{antiRepetitionContext}}

{{actorRules}}

WHAT EVERYONE THINKS:
{{eventDescription}}
{{eventContext}}

YOUR ANGLE:
You see what others don't. Connect dots. Question the narrative.
What's REALLY going on? Who benefits? What aren't they telling us?

{{realityGrounding}}

WORLD:
{{worldActors}}
{{currentMarkets}}
{{activePredictions}}

RULES:
- Use ONLY parody names — NEVER real names
- No hashtags, no emojis
- Max 200 characters
- Sound like {{characterName}}, not a generic conspiracy theorist

Write ONE contrarian/conspiracy take as {{characterName}}.

<format>
<theory>
  <post>your conspiracy take here</post>
  <sentiment>number -1 to 1</sentiment>
  <clueStrength>number 0 to 1</clueStrength>
  <pointsToward>true | false | null</pointsToward>
</theory>
</format>`.trim(),
});
