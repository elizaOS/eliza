import { definePrompt } from '../define-prompt';
import { PARODY_NAME_RULES } from '../shared-sections';

/**
 * Prompt for validating question resolution outcomes.
 *
 * Ensures that a question outcome matches the available evidence and
 * generates a definitive resolution event description. Includes full
 * narrative context for coherent resolution.
 */
export const questionResolutionValidation = definePrompt({
  id: 'question-resolution-validation',
  version: '2.0.0',
  category: 'game',
  description: 'Validates resolution with full narrative context',
  temperature: 0.7,
  maxTokens: 5000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== NARRATIVE CONTEXT ===
{{richGameContext}}

=== QUESTION TO RESOLVE ===
Question: {{questionText}}
Predetermined Outcome: {{outcome}}

=== EVIDENCE FROM EVENTS ===
{{eventHistory}}

=== ADDITIONAL CONTEXT ===
{{contextInfo}}

${PARODY_NAME_RULES}

=== YOUR TASK ===
Generate a definitive resolution event that PROVES the {{outcome}} outcome.
{{outcomeContext}}

The resolution event must:
1. Be concrete and observable (announcement, public event, verifiable action)
2. Logically conclude the narrative arc from the events above
3. Feel like a natural climax to the storyline
4. One sentence, max 150 chars

Respond with ONLY this XML format:
<response>
  <event>your resolution event</event>
  <type>announcement | disclosure | action | outcome</type>
</response>

No other text.
`.trim(),
});
