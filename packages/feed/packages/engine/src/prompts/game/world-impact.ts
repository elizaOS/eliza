import { definePrompt } from '../define-prompt';

/**
 * Prompt for assessing if a resolved question/event changes the world state.
 *
 * Evaluates whether a question resolution or event should be added to the
 * permanent world facts that inform all future content generation.
 * Includes full narrative context to avoid duplicate world facts.
 */
export const worldImpactAssessment = definePrompt({
  id: 'world-impact-assessment',
  version: '3.0.0',
  category: 'game',
  description: 'Assess if a resolved question/event changes the world state',
  temperature: 0.3, // Low temperature for factual assessment
  maxTokens: 3000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

You are the World State Manager for a satirical simulation.
A prediction market question has just resolved, and an event has occurred.

Your job is to determine if this event SIGNIFICANTLY changes the state of the world.
If it does, you must generate a concise "World Fact" to be added to the global context.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== CHARACTERS AFFECTED BY THIS RESOLUTION ===
{{affectedCharacterProfiles}}

=== ORGANIZATIONS ===
{{organizationRoster}}

=== COMPLETE NARRATIVE HISTORY ===
{{richGameContext}}

=== CURRENT WORLD FACTS (Already established - DON'T DUPLICATE) ===
{{worldFacts}}

=== ALL PREVIOUSLY RESOLVED QUESTIONS ===
{{resolvedQuestionsContext}}

=== THIS RESOLUTION ===
Question: {{questionText}}
Outcome: {{outcome}} ({{outcomeText}})
Resolution event: {{resolutionEvent}}

=== ANALYSIS CRITERIA ===
Does this event FUNDAMENTALLY change the world state?

Examples that CHANGE world state:
- New leadership (president, CEO) installed
- Company bankruptcy or acquisition completed
- Major product/technology released
- New law or regulation enacted
- Significant relationship change (merger, split, alliance)
- Death, resignation, or departure of major figure

Examples that DON'T change world state:
- Daily market movements
- Routine announcements
- Speculation or rumors
- Events that don't have lasting implications
- Things covered by existing world facts

=== INSTRUCTIONS ===
1. Review existing world facts above - DON'T create duplicates
2. Review resolved questions - many outcomes are already captured
3. Only add NEW, SIGNIFICANT, PERMANENT changes
4. Most events (80%+) should NOT create new world facts
5. If adding a fact, make it concise and factual (1 sentence, max 100 chars)

Output JSON format:
{
  "changesWorld": boolean,
  "reasoning": "Brief explanation of why this does/doesn't change world state",
  "newFact": string | null,
  "relatedExistingFacts": ["list of existing facts this relates to"]
}
`,
});
