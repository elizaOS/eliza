import { definePrompt } from '../define-prompt';
import {
  ANTI_REPETITION_RULES,
  CONTENT_REQUIREMENTS,
  FINAL_REMINDERS,
  WORLD_CONTEXT_HEADER,
} from '../shared-sections';

/**
 * Prompt for generating single company PR statements or announcements.
 *
 * Creates corporate posts from a company's PR team perspective, responding
 * to events or announcements. Uses professional corporate speak while
 * referencing specific actors, markets, and events from world context.
 * Includes full narrative context for consistent corporate messaging.
 *
 * Returns XML with post content and sentiment analysis metadata.
 */
export const companyPost = definePrompt({
  id: 'company-post',
  version: '4.0.0',
  category: 'feed',
  description: 'Company PR with full narrative context',
  temperature: 0.9,
  maxTokens: 5000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== COMPLETE NARRATIVE CONTEXT ===
{{richGameContext}}

=== {{companyName}}'S PREVIOUS STATEMENTS (DON'T CONTRADICT) ===
{{previousStatements}}

=== COMPANY PROFILE ===
Company: {{companyName}}
About: {{companyDescription}}
Current position in narratives: {{companyNarrativePosition}}

=== EVENT TO RESPOND TO ===
Event: {{eventDescription}} ({{eventType}})

=== CONTEXT ===
${WORLD_CONTEXT_HEADER}

This is a {{postType}}.
{{outcomeFrame}}

=== CORPORATE CONTINUITY ===
- Must be consistent with previous company statements
- Reference ongoing storylines appropriately
- Don't contradict established positions

${ANTI_REPETITION_RULES}

Write ONE corporate post (max 200 chars).
Professional, on-brand corporate speak.

${CONTENT_REQUIREMENTS}

Respond with ONLY this XML format:
<response>
  <post>your corporate statement here</post>
  <sentiment>0.5</sentiment>
  <clueStrength>0.3</clueStrength>
  <pointsToward>true</pointsToward>
</response>

sentiment: -1 (very negative) to 1 (very positive)
clueStrength: 0 (no info) to 1 (smoking gun)
pointsToward: true/false/null (does this help guilty party?)

${FINAL_REMINDERS}

No other text.
`.trim(),
});
