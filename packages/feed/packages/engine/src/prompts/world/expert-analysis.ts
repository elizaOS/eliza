import { definePrompt } from "../define-prompt";
import { ANTI_REPETITION_RULES, PARODY_NAME_RULES } from "../shared-sections";

/**
 * Prompt for generating expert analysis from NPCs with domain expertise.
 *
 * Creates analytical commentary from expert NPCs providing informed
 * perspectives on game events, market movements, or technical matters.
 * Reflects the expert's domain knowledge and analytical style.
 * Includes full narrative context for nuanced, contextual analysis.
 *
 * Returns XML with expert analysis.
 */
export const expertAnalysis = definePrompt({
  id: "expert-analysis",
  version: "4.0.0",
  category: "world",
  description: "Generates expert analysis with full character context",
  temperature: 0.7,
  maxTokens: 1000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== EXPERT'S FULL PROFILE ===
{{expertProfile}}

=== EXPERT'S RELATIONSHIPS ===
{{expertRelationships}}

=== COMPLETE NARRATIVE CONTEXT ===
{{richGameContext}}

=== EXPERT'S PREVIOUS STATEMENTS ===
{{expertPreviousStatements}}

=== CURRENT ANALYSIS REQUEST ===
Question: {{question}}
Real outcome: {{outcome}}
Expert: {{expertName}} ({{expertRole}})
- Knows truth: {{knowsTruth}}
- Reliability: {{reliability}}

Recent events to analyze:
{{recentEvents}}

${PARODY_NAME_RULES}

=== ANALYSIS REQUIREMENTS ===
Generate expert analysis that:
1. Sounds authoritative and domain-specific to {{expertRole}}
2. {{confidenceContext}}
3. Reflects expert's reliability level ({{reliabilityContext}})
4. References ongoing narratives from the context above
5. Builds on or contradicts their previous statements (if any)
6. Connects to resolved questions when relevant

${ANTI_REPETITION_RULES}

CRITICAL: Check the expert's previous statements above. Don't repeat the same analysis. Evolve their position or provide new insights.

Respond with XML:
<response>
  <analysis>Expert analysis that sounds like a real {{expertRole}} providing informed commentary. Max 300 chars.</analysis>
  <confidence>high|medium|low - based on how certain the expert would be</confidence>
  <references>comma-separated list of events/questions referenced</references>
</response>

No other text.
`.trim(),
});
