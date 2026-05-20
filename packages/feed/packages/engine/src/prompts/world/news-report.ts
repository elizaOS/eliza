import { definePrompt } from "../define-prompt";
import {
  NARRATIVE_CONTINUITY_RULES,
  PARODY_NAME_RULES,
} from "../shared-sections";

/**
 * Prompt for generating news reports from journalists covering game events.
 *
 * Creates journalistic news reports covering game events with breaking
 * news urgency and objective reporting style. References specific events,
 * actors, and market impacts. Includes full narrative context for
 * comprehensive, connected journalism.
 *
 * Returns XML with news report.
 */
export const newsReport = definePrompt({
  id: "news-report",
  version: "4.0.0",
  category: "world",
  description: "Generates news reports with full character context",
  temperature: 0.8,
  maxTokens: 1500,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== JOURNALIST'S FULL PROFILE ===
{{journalistProfile}}

=== ORGANIZATIONS ===
{{organizationRoster}}

=== COMPLETE NEWS CONTEXT ===
{{richGameContext}}

=== PREVIOUS COVERAGE BY THIS OUTLET ===
{{previousCoverage}}

=== TODAY'S STORY (Day {{day}}) ===
Primary question: {{question}}
Expected outcome: {{outcome}}

Journalist: {{journalistName}}
- Role: {{journalistRole}}
- Reliability: {{journalistReliability}}
- Outlet reputation: {{reputationContext}}

Events to cover:
{{recentEvents}}

${PARODY_NAME_RULES}

${NARRATIVE_CONTINUITY_RULES}

=== JOURNALISTIC REQUIREMENTS ===
Generate news coverage that:
1. Sounds like real journalism from a {{reputationContext}} outlet
2. References the complete event history above for context
3. Connects this story to ongoing narratives
4. Subtly {{truthContext}} the outcome (consistent with reliability)
5. Builds on previous coverage without repeating old headlines
6. Cites sources and actors by their parody names

ANTI-REPETITION: Review previous coverage above. This report must advance the story, not rehash what was already reported.

NARRATIVE CONTINUITY: Reference resolved questions as established facts. Connect to ongoing storylines.

Respond with XML:
<response>
  <headline>Punchy, newsworthy headline (max 80 chars)</headline>
  <report>Full news report with context, quotes, and implications (max 500 chars)</report>
  <tone>breaking|investigative|analysis|opinion</tone>
  <sourcesCount>number of sources cited</sourcesCount>
</response>

No other text.
`.trim(),
});
