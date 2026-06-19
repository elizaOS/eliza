import { definePrompt } from "../define-prompt";
import { PARODY_NAME_RULES } from "../shared-sections";

/**
 * Prompt for generating one-line summaries of daily events.
 *
 * Creates concise summaries that capture the key developments of a game day,
 * including question context, events, and outcomes. Uses parody names only,
 * never real names. Includes full narrative context for continuity.
 *
 * Returns XML with one-line day summary.
 */
export const daySummary = definePrompt({
  id: "day-summary",
  version: "4.0.0",
  category: "world",
  description: "Generates one-line summaries with full character context",
  temperature: 0.6,
  maxTokens: 500,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== KEY ACTORS TODAY ===
{{keyActorProfiles}}

=== NARRATIVE CONTEXT ===
{{richGameContext}}

=== PREVIOUS DAY SUMMARIES ===
{{previousDaySummaries}}

=== TODAY'S CONTEXT (Day {{day}}) ===
Question: {{question}}
Events today: {{eventsToday}}
Real outcome: {{outcome}}
Phase: {{phaseContext}}

${PARODY_NAME_RULES}

=== YOUR TASK ===
Generate a ONE-LINE summary (max 150 chars) for Day {{day}} that:
1. Captures the day's most significant development
2. Connects to ongoing narratives when relevant
3. Builds on previous day summaries (don't repeat)
4. Hints at the outcome without being explicit
5. Uses parody names exclusively

ANTI-REPETITION: Review previous day summaries above. Your summary must cover NEW ground, not rehash earlier events.

Respond with XML:
<response>
  <summary>One compelling line summarizing Day {{day}}'s key development</summary>
</response>

No other text.
`.trim(),
});
