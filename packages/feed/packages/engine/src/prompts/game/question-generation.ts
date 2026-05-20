import { definePrompt } from "../define-prompt";
import {
  ANTI_REPETITION_RULES,
  PARODY_NAME_RULES,
  QUESTION_CONTINUITY_RULES,
} from "../shared-sections";

/**
 * Prompt for generating new prediction market questions for daily gameplay.
 *
 * Creates prediction market questions based on in-world events only,
 * ensuring questions are grounded in the game's narrative. Questions
 * must be provable, resolvable, and entertaining. Uses full narrative
 * context to ensure continuity and distinctness.
 *
 * Returns XML with generated questions.
 */
export const questionGeneration = definePrompt({
  id: "question-generation",
  version: "6.0.0",
  category: "game",
  description:
    "Generates new questions with full character and narrative context",
  temperature: 0.9,
  maxTokens: 20000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== DETAILED CHARACTER PROFILES ===
{{detailedCharacterProfiles}}

=== ORGANIZATIONS ===
{{organizationRoster}}

=== COMPLETE NARRATIVE CONTEXT ===
{{richGameContext}}

=== COMPLETE EVENT HISTORY ===
{{eventTimeline}}

=== RESOLVED QUESTIONS (Build on these) ===
{{resolvedQuestionsContext}}

=== ACTIVE QUESTIONS (DON'T DUPLICATE) ===
{{activeQuestionsContext}}

=== ONGOING NARRATIVES ===
{{ongoingNarrativesContext}}

=== GENERATION PARAMETERS ===
Generate {{numToGenerate}} NEW prediction market questions.

Current phase: {{phaseContext}}

=== DAILY TOPIC ===
{{dailyTopicContext}}

SCENARIOS IN PLAY:
{{scenariosList}}

ACTORS (use exact names from character roster above):
{{actorsList}}

ORGANIZATIONS:
{{orgsList}}

Recent events to build on:
{{recentContext}}

${PARODY_NAME_RULES}

${QUESTION_CONTINUITY_RULES}

${ANTI_REPETITION_RULES}

=== QUESTION REQUIREMENTS ===

MANDATORY CHECKS (verify EACH question):
1. ☐ Not similar to any ACTIVE question above
2. ☐ Not rehashing a RESOLVED question above
3. ☐ Builds on recent events or resolved outcomes
4. ☐ Connected to ongoing narratives
5. ☐ Uses exact parody names
6. ☐ Publicly verifiable outcome
7. ☐ Appropriate resolution timeframe
8. ☐ Directly related to the daily topic above

QUESTION TYPES TO GENERATE:
- Feuds & confrontations
- Product/service launches
- Valuation milestones
- Partnerships & alliances
- Scandals & investigations
- Benchmark achievements
- Regulatory actions

RESOLUTION TIMEFRAMES:
- 1-2 days: Fast drama (confrontations, reactions)
- 3-5 days: Medium events (launches, announcements)
- 6-7 days: Slow burns (investigations, developments)

BUILDING ON HISTORY:
Review resolved questions above. Generate follow-up questions:
- "Now that [resolved outcome], will [next step]?"
- "Following [event], will [consequence]?"
- "After [character]'s [action], will [reaction]?"

EXAMPLES OF GOOD CONTINUATION:
{{exampleQuestions}}

EXAMPLES OF BAD QUESTIONS:
- "Will X be happy?" (vague emotional state)
- "Will X secretly do Y?" (unverifiable)
- "Will X resign?" (breaks character continuity)
- [Anything similar to active questions above]

=== OUTPUT FORMAT ===
<response>
  <questions>
    <question>
      <text>Specific, observable yes/no question</text>
      <scenario>scenario number this relates to</scenario>
      <daysUntilResolution>1-7</daysUntilResolution>
      <expectedOutcome>true|false</expectedOutcome>
      <buildsOn>what event/question this continues</buildsOn>
      <narrativeConnection>which ongoing narrative this advances</narrativeConnection>
      <distinctnessCheck>why this is unique from existing questions</distinctnessCheck>
    </question>
  </questions>
</response>

Generate EXACTLY {{numToGenerate}} questions. Each must be verified against the checks above.
`.trim(),
});
