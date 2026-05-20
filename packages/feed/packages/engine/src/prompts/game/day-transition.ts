import { definePrompt } from "../define-prompt";
import { PARODY_NAME_RULES } from "../shared-sections";

/**
 * Prompt for generating day transition summary events.
 *
 * Creates brief transition events marking the start of a new day,
 * summarizing what happened previously and setting up the new day's
 * context. Used for narrative continuity between game days.
 * Includes full history for seamless transitions.
 *
 * Returns XML with day transition summary.
 */
export const dayTransition = definePrompt({
  id: "day-transition",
  version: "4.0.0",
  category: "game",
  description: "Generates day transition with full character context",
  temperature: 0.7,
  maxTokens: 2000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== KEY ACTORS TODAY ===
{{keyActorProfiles}}

=== COMPLETE NARRATIVE HISTORY ===
{{richGameContext}}

=== DAY-BY-DAY SUMMARY ===
{{daySummaries}}

=== YESTERDAY (Day {{previousDay}}) DETAILS ===
Events: {{previousDayEvents}}
Questions resolved: {{yesterdayResolutions}}
Significant developments: {{yesterdayHighlights}}

=== TODAY (Day {{day}}) SETUP ===
Phase: {{phaseName}}
{{phaseContext}}

Active questions awaiting resolution:
{{activeQuestions}}

Key actors in play:
{{keyActors}}

Ongoing narratives:
{{ongoingNarratives}}

${PARODY_NAME_RULES}

=== TRANSITION REQUIREMENTS ===

Generate a "Day {{day}} begins" transition that:
1. Acknowledges the move to a new day
2. References yesterday's most significant event
3. Sets up today's dramatic tension
4. Hints at what's to come (based on phase)
5. Feels like a news ticker or broadcast opening
6. Max 200 characters
7. Satirical but urgent tone

PHASE GUIDANCE:
- WILD: Mysterious, cryptic openings
- CONNECTION: Building tension, patterns emerging
- CONVERGENCE: Dramatic, revelatory tone
- CLIMAX: Maximum urgency, stakes at peak
- RESOLUTION: Conclusive, definitive

DON'T:
- Repeat the exact same transition style from previous days
- Ignore yesterday's major events
- Sound generic or disconnected

Respond with ONLY this XML:
<response>
  <event>Day {{day}} transition (max 200 chars, headline style)</event>
  <type>day-transition</type>
  <tone>anticipatory|tense|revelatory|climactic|conclusive</tone>
  <referencesYesterday>what from yesterday is referenced</referencesYesterday>
  <setsUp>what today's tension will be about</setsUp>
</response>

No other text.
`.trim(),
});
