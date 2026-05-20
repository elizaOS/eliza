import { definePrompt } from '../define-prompt';
import {
  ANTI_REPETITION_RULES,
  CONTENT_REQUIREMENTS,
  FINAL_REMINDERS,
  WORLD_CONTEXT_HEADER,
} from '../shared-sections';

/**
 * Prompt for generating single government agency response or statement.
 *
 * Creates official government posts from agencies responding to events
 * or making policy announcements. Uses formal, bureaucratic tone while
 * referencing specific events and actors. Includes full context for
 * consistent government messaging.
 *
 * Returns XML with government statement and metadata.
 */
export const governmentPost = definePrompt({
  id: 'government-post',
  version: '4.0.0',
  category: 'feed',
  description: 'Government statement with full narrative context',
  temperature: 0.9,
  maxTokens: 5000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== COMPLETE NARRATIVE CONTEXT ===
{{richGameContext}}

=== {{govName}}'S PREVIOUS STATEMENTS (Maintain consistency) ===
{{previousStatements}}

=== AGENCY PROFILE ===
Agency: {{govName}}
About: {{govDescription}}
Current investigations/actions: {{agencyActions}}

=== EVENT REQUIRING RESPONSE ===
Event: {{eventDescription}} ({{eventType}})

=== CONTEXT ===
${WORLD_CONTEXT_HEADER}

{{outcomeFrame}}

=== GOVERNMENT CONSISTENCY ===
- Must be consistent with previous agency statements
- Reference ongoing investigations if relevant
- Maintain official, cautious tone

${ANTI_REPETITION_RULES}

Write ONE official government statement (max 200 chars).
Bureaucratic, cautious, official tone.

${CONTENT_REQUIREMENTS}

Respond with ONLY this XML format:
<response>
  <post>your official statement here</post>
  <sentiment>0.0</sentiment>
  <clueStrength>0.2</clueStrength>
  <pointsToward>null</pointsToward>
</response>

sentiment: -1 (very negative) to 1 (very positive)
clueStrength: 0 (no info) to 1 (smoking gun)
pointsToward: true/false/null (does this help guilty party?)

${FINAL_REMINDERS}

No other text.
`.trim(),
});
