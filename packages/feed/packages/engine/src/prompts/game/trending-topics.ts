import { definePrompt } from '../define-prompt';
import { ANTI_REPETITION_RULES, PARODY_NAME_RULES } from '../shared-sections';

/**
 * Prompt for generating trending topic descriptions from clustered posts.
 *
 * Analyzes post clusters to create catchy trend names and micro-summaries.
 * Output is satirical and captures the essence of social media conversations.
 * Includes narrative context for connected, evolving trends.
 */
export const trendingTopics = definePrompt({
  id: 'trending-topics',
  version: '2.0.0',
  category: 'game',
  description: 'Generates trends with narrative context',
  temperature: 0.85,
  maxTokens: 3000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== NARRATIVE CONTEXT ===
{{richGameContext}}

=== PREVIOUS TRENDS (Don't repeat) ===
{{previousTrends}}

=== RESOLVED QUESTIONS (Can be topics) ===
{{resolvedQuestionsContext}}

=== CURRENT POST CLUSTERS ===
{{topicsList}}

${PARODY_NAME_RULES}

${ANTI_REPETITION_RULES}

=== TRENDING REQUIREMENTS ===
For each cluster, create:
1) Catchy trend name (3-6 words, title case)
2) Micro-summary (1-2 sentences)
3) Connection to ongoing narratives

TREND VARIETY:
- Don't repeat trend names from previous trends above
- Connect to ongoing storylines when relevant
- Be satirical and social-media authentic

XML:
<response>
  <trends>
    <trend>
      <trendName>Catchy Title Here</trendName>
      <description>1-2 sentence satirical summary</description>
      <connectsTo>which narrative this relates to</connectsTo>
    </trend>
  </trends>
</response>`.trim(),
});
