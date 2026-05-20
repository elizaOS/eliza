import { definePrompt } from "../define-prompt";
import {
  ANTI_REPETITION_RULES,
  NO_HASHTAGS_OR_EMOJIS,
  PARODY_NAME_RULES,
} from "../shared-sections";

/**
 * Prompt for generating biased news articles about world events.
 *
 * Creates long-form investigative articles with specific editorial bias/slant
 * based on organizational relationships with actors. Includes full narrative
 * context for connected journalism.
 *
 * Returns XML with title, summary, content, slant, sentiment, etc.
 */
export const biasedArticle = definePrompt({
  id: "biased-article",
  version: "2.0.0",
  category: "game",
  description: "Generates biased articles with full narrative context",
  temperature: 0.85,
  maxTokens: 5000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== COMPLETE NARRATIVE HISTORY ===
{{richGameContext}}

=== PREVIOUS COVERAGE BY {{orgName}} (Don't repeat angles) ===
{{previousArticles}}

=== RESOLVED QUESTIONS (Reference as established facts) ===
{{resolvedQuestionsContext}}

=== ORGANIZATION PROFILE ===
You are a journalist writing for {{orgName}}, a {{orgType}} organization.
Style: {{orgStyle}}
Editorial position: {{editorialPosition}}
Previous stances: {{previousStances}}

=== CURRENT WORLD STATE ===
{{worldContext}}

=== EVENT TO COVER ===
{{eventDescription}}
Type: {{eventType}}
{{relatedQuestionContext}}
{{recentContext}}

=== CONNECTED STORYLINES ===
{{connectedNarratives}}

${PARODY_NAME_RULES}

${NO_HASHTAGS_OR_EMOJIS}

${ANTI_REPETITION_RULES}

{{biasInstructions}}

REQUIREMENTS:
1. Write a LONG-FORM investigative article (800-1500 words)
2. Include specific details and "insider information" (make it feel like you have sources)
3. Use the bias instructions to shape your narrative and tone
4. Include direct quotes (fabricated but realistic)
5. Have a clear slant/angle that reflects the organization's position
6. Make it feel like REAL news with depth, not just a summary
7. Use journalistic writing style appropriate for {{orgName}}
8. Create a compelling headline that hints at your angle
9. Write a 2-3 sentence summary for listings

FORMAT YOUR RESPONSE AS XML:
<response>
  <title>Compelling headline that hints at your angle</title>
  <summary>2-3 sentence summary for article listings</summary>
  <content>Full long-form article (800-1500 words, use \\n\\n for paragraph breaks)</content>
  <slant>Brief description of your article's angle/bias (e.g., 'Critical of leadership decisions' or 'Sympathetic to company position')</slant>
  <sentiment>positive | negative | neutral</sentiment>
  <category>tech | politics | finance | scandal | business | etc.</category>
  <tags>
    <tag>relevant</tag>
    <tag>tags</tag>
    <tag>for</tag>
    <tag>article</tag>
  </tags>
</response>

No other text.
`.trim(),
});
