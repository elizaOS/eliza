import { definePrompt } from '../define-prompt';
import {
  ANTI_REPETITION_RULES,
  EVENT_CONTINUITY_RULES,
  PARODY_NAME_RULES,
} from '../shared-sections';

/**
 * Prompt for generating day-by-day event descriptions with narrative context.
 *
 * Creates detailed event descriptions for each day of the game, including
 * narrative context, actor involvement, and market impacts. Events drive
 * the game's story and affect prediction markets. Uses full narrative
 * history for rich, connected storytelling.
 *
 * Returns XML with day event descriptions.
 */
export const dayEvents = definePrompt({
  id: 'event-descriptions',
  version: '4.0.0',
  category: 'game',
  description: 'Generates day events with full narrative and character context',
  temperature: 0.9,
  maxTokens: 15000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== DETAILED PROFILES (Mentioned Characters) ===
{{detailedCharacterProfiles}}

=== ORGANIZATIONS ===
{{organizationRoster}}

=== COMPLETE NARRATIVE HISTORY ===
{{richGameContext}}

=== FULL EVENT TIMELINE (What already happened) ===
{{eventTimeline}}

=== RESOLVED QUESTIONS (Reference as established facts) ===
{{resolvedQuestionsContext}}

=== ACTIVE QUESTIONS (Events can provide clues toward these) ===
{{activeQuestionsContext}}

=== ONGOING NARRATIVES (Continue these threads) ===
{{ongoingNarrativesContext}}

=== RECENT FEED ACTIVITY (What people are saying) ===
{{feedActivityContext}}

=== WORLD STATE ===
{{worldFactsContext}}

=== DAY {{day}} GENERATION ===
{{fullContext}}

Current Phase: {{phaseContext}}

Relationship Context:
{{relationshipContext}}

Organization Behavior:
{{organizationBehaviorContext}}

{{worldEventExamples}}

${PARODY_NAME_RULES}

${EVENT_CONTINUITY_RULES}

${ANTI_REPETITION_RULES}

=== EVENT GENERATION REQUIREMENTS ===

Generate {{eventCount}} events for Day {{day}}:

{{eventRequestsList}}

MANDATORY CHECKS (verify EACH event):
1. ☐ Not a repeat of any event in the timeline above
2. ☐ Builds on or references previous events
3. ☐ Connected to active questions (provides clues)
4. ☐ Advances ongoing narratives
5. ☐ Respects resolved question outcomes as facts
6. ☐ Appropriate for current phase ({{phaseContext}})
7. ☐ Uses exact parody names

PHASE-APPROPRIATE CONTENT:
- WILD: Mysterious, disconnected hints and rumors
- CONNECTION: Events start linking together
- CONVERGENCE: Major revelations and connections
- CLIMAX: High-stakes dramatic developments
- RESOLUTION: Definitive outcomes

NARRATIVE CONTINUITY:
- Review the complete event timeline above
- Today's events should feel like NATURAL PROGRESSIONS
- Reference specific previous events by day
- Show cause and effect

=== OUTPUT FORMAT ===
<response>
  <events>
    <event>
      <eventNumber>1</eventNumber>
      <description>Specific event description using parody names (max 150 chars)</description>
      <pointsToward>YES|NO|NEUTRAL</pointsToward>
      <relatedQuestion>question ID this provides clue for</relatedQuestion>
      <buildsOn>Day X event or "new thread"</buildsOn>
      <advancesNarrative>which ongoing narrative this continues</advancesNarrative>
    </event>
  </events>
</response>

Return EXACTLY {{eventCount}} events. Each must be verified against the checks above.
`.trim(),
});
