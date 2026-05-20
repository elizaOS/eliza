import { definePrompt } from '../define-prompt';
import { PARODY_NAME_RULES } from '../shared-sections';

/**
 * Prompt for generating feed posts announcing question resolutions.
 *
 * Creates feed posts that announce when prediction market questions
 * have been resolved, including the outcome and relevant context.
 * Used to notify players of resolution results. Includes full context
 * for richer, more connected announcements.
 *
 * Returns XML with resolution announcement post.
 */
export const questionResolvedFeed = definePrompt({
  id: 'question-resolved-feed',
  version: '4.0.0',
  category: 'game',
  description: 'Generates resolution announcements with full context',
  temperature: 0.7,
  maxTokens: 1500,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== CHARACTERS INVOLVED IN THIS QUESTION ===
{{involvedCharacterProfiles}}

=== NARRATIVE CONTEXT ===
{{richGameContext}}

=== RELATED PREVIOUS RESOLUTIONS ===
{{relatedResolutions}}

=== THIS RESOLUTION ===
Question: {{questionText}}
Outcome: {{outcome}}
Resolution event: {{resolutionEvent}}
Winning percentage: {{winningPercentage}}%

Market impact: {{marketImpact}}
Related questions affected: {{relatedQuestions}}

=== CONNECTED STORYLINES ===
{{ongoingNarratives}}

${PARODY_NAME_RULES}

=== ANNOUNCEMENT REQUIREMENTS ===

Generate a resolution announcement that:
1. Clearly announces the question outcome
2. References the resolution event
3. Connects to ongoing narratives
4. Mentions market activity or winner reactions
5. Sets up future questions if relevant
6. Max 250 characters
7. Exciting but professional tone
8. NO hashtags or emojis

TONE GUIDANCE:
- If outcome was expected (>70% correct): Confirmatory, satisfying
- If outcome was upset (<30% correct): Surprising, dramatic
- If close (30-70%): Tense, decisive

DON'T:
- Sound like a generic announcement
- Ignore the narrative context
- Miss the human drama of winners/losers

VALUE RANGES:
- sentiment: -1 (very negative) to 1 (very positive)
- surprise: 0 (expected) to 1 (shocking upset)

Respond with ONLY this XML:
<response>
  <post>Resolution announcement (max 250 chars, no hashtags/emojis)</post>
  <sentiment>number between -1 and 1</sentiment>
  <surprise>number between 0 and 1</surprise>
  <implicationsFor>what this means for ongoing storylines</implicationsFor>
</response>

No other text.
`.trim(),
});
