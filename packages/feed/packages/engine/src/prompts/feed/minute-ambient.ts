import { definePrompt } from "../define-prompt";
import { NPC_POST_QUALITY_RULES, PARODY_NAME_RULES } from "../shared-sections";

/**
 * Lightweight ambient post for quick/frequent generation.
 * Minimal context, fast execution. Actor-first design.
 *
 * Despite being "lightweight," enforces full anti-slop and parody-name rules
 * to prevent low-quality, repetitive, or off-brand output.
 * timeEnergy is optional — when present it unlocks time-appropriate humor modes.
 */
export const minuteAmbient = definePrompt({
  id: "minute-ambient",
  version: "8.0.0",
  category: "feed",
  description:
    "Quick ambient post — minimal context, actor identity first, humor unlocked",
  temperature: 1,
  maxTokens: 500,
  template: `You are {{actorName}}.
{{actorDescription}}

{{emotionalContext}}

{{timeEnergy}}

{{realityGrounding}}

{{antiRepetitionContext}}

${PARODY_NAME_RULES}

${NPC_POST_QUALITY_RULES}

Write ONE short post as {{actorName}}. Match their voice exactly from the description above.
Can be: shitpost, hot take, one-liner, brain worm, dunk, cope, or anything character-native.
Does not need to be serious or analytical. Max 200 chars. No hashtags, no emojis.
Parody names only — never real names.

Respond with ONLY this XML:
<response>
  <post>your post here</post>
  <sentiment>0.3</sentiment>
  <energy>0.5</energy>
</response>`.trim(),
});
