import { definePrompt } from '../define-prompt';
import { ANTI_REPETITION_RULES, PARODY_NAME_RULES } from '../shared-sections';

/**
 * Prompt for generating rumors and unconfirmed information for game world.
 *
 * Creates speculative rumors circulating in the game world about events,
 * actors, or market movements. Adds intrigue and uncertainty while
 * maintaining narrative consistency. Uses full narrative context to
 * ensure rumors connect to ongoing storylines.
 *
 * Returns XML with rumor content.
 */
export const rumor = definePrompt({
  id: 'rumor',
  version: '4.0.0',
  category: 'world',
  description: 'Generates contextually-connected rumors with character context',
  temperature: 0.9,
  maxTokens: 800,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== KEY CHARACTERS TO RUMOR ABOUT ===
{{rumorTargetProfiles}}

=== ORGANIZATIONS ===
{{organizationRoster}}

=== COMPLETE WORLD CONTEXT ===
{{richGameContext}}

=== PREVIOUS RUMORS (Don't repeat) ===
{{previousRumors}}

=== RUMOR GENERATION (Day {{day}}) ===
Question context: {{question}}
Real outcome: {{outcome}}
Phase: {{phaseContext}}

Recent events that could spawn rumors:
{{recentEvents}}

Active storylines to reference:
{{ongoingNarratives}}

${PARODY_NAME_RULES}

=== RUMOR REQUIREMENTS ===
Generate a rumor that:
1. Sounds like authentic internet gossip or insider leak
2. Connects to events or narratives in the context above
3. May or may not be accurate (adds uncertainty)
4. {{outcomeHint}}
5. Introduces NEW information (check previous rumors above)
6. References specific actors/companies by parody names

${ANTI_REPETITION_RULES}

RUMOR SOURCES (vary these):
- "Rumor:"
- "Unconfirmed:"  
- "Sources say:"
- "Insider claims:"
- "Leaked memo suggests:"
- "Anonymous tipster:"
- "Industry whispers:"

PHASE GUIDANCE:
- WILD phase: Vague, mysterious rumors
- CONNECTION phase: Rumors linking actors/events
- CONVERGENCE phase: Rumors hinting at revelations
- CLIMAX phase: Dramatic, high-stakes rumors
- RESOLUTION phase: Rumors about aftermath

Respond with XML:
<response>
  <rumor>The rumor text, starting with source attribution (max 200 chars)</rumor>
  <credibility>high|medium|low - how believable</credibility>
  <accuracy>true|false|mixed - does it align with real outcome?</accuracy>
  <connectsTo>what storyline or question this relates to</connectsTo>
</response>

No other text.
`.trim(),
});
