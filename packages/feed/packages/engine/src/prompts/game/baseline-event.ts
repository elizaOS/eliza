import { definePrompt } from "../define-prompt";
import { ANTI_REPETITION_RULES, PARODY_NAME_RULES } from "../shared-sections";

/**
 * Prompt for generating normal, mundane baseline events for genesis game.
 *
 * Creates everyday events that provide background atmosphere without
 * major dramatic impact. Used to establish normalcy before major events
 * occur in the game. Includes context to ensure events don't repeat.
 *
 * Returns XML with baseline event description.
 */
export const baselineEvent = definePrompt({
  id: "baseline-event",
  version: "3.0.0",
  category: "game",
  description: "Generates baseline events with narrative context",
  temperature: 0.7,
  maxTokens: 5000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== PREVIOUS EVENTS (DON'T REPEAT) ===
{{previousEvents}}

{{worldEventExamples}}

${PARODY_NAME_RULES}

${ANTI_REPETITION_RULES}

Date: {{dateStr}}
Event type: {{eventType}}
Involved: {{actorDescriptions}}

Generate a normal, mundane baseline event. One sentence, max 100 chars.
CRITICAL: Must be DISTINCT from previous events above.

Respond with ONLY this XML format:
<response>
  <event>your event description</event>
</response>

No other text.
`.trim(),
});
