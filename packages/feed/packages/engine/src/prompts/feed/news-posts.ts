import { definePrompt } from "../define-prompt";
import {
  ANTI_REPETITION_RULES,
  FINAL_REMINDERS,
  STANDARD_FEED_RULES,
  VALUE_RANGES,
  WORLD_CONTEXT_HEADER,
} from "../shared-sections";

/**
 * Prompt for generating breaking news posts from media entities.
 *
 * Creates news-style posts from media organizations reporting on world
 * events. Uses journalistic tone and references specific events, actors,
 * and market impacts. Includes full narrative context for connected
 * journalism that builds on previous coverage.
 *
 * Returns XML with news post content and metadata.
 */
export const newsPosts = definePrompt({
  id: "news-posts",
  version: "4.0.0",
  category: "feed",
  description: "Generates breaking news with full character context",
  temperature: 0.8,
  maxTokens: 8000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== DETAILED CHARACTER PROFILES ===
{{detailedCharacterProfiles}}

=== ORGANIZATIONS ===
{{organizationRoster}}

=== COMPLETE NEWS CONTEXT ===
{{richGameContext}}

=== PREVIOUS COVERAGE (DON'T REHASH) ===
{{previousCoverage}}

=== THIS STORY ===
Event: {{eventDescription}}
Type: {{eventType}}
{{sourceContext}}
{{outcomeFrame}}

=== HOW THIS CONNECTS ===
Related ongoing stories: {{relatedStories}}
Related questions: {{relatedQuestions}}
Connected actors: {{connectedActors}}

{{phaseContext}}

{{orgBehaviorContext}}

${WORLD_CONTEXT_HEADER}

${STANDARD_FEED_RULES}

${ANTI_REPETITION_RULES}

Generate breaking news posts for these {{mediaCount}} media entities:

{{mediaList}}

JOURNALISTIC CONTINUITY:
- Reference previous coverage when relevant
- Connect to ongoing narratives
- Each outlet should have distinct angle
- Don't repeat old headlines

${VALUE_RANGES}

Respond with ONLY this XML format (example for 2 posts):
<response>
  <posts>
    <post>
      <content>BREAKING: TeslAI to accept DogecAIn for Full Self-Driving. Analysts divided on crypto payment strategy.</content>
      <sentiment>0.2</sentiment>
      <clueStrength>0.4</clueStrength>
      <pointsToward>null</pointsToward>
    </post>
    <post>
      <content>OpenAGI claims SMH-9000 shows signs of consciousness during overnight tests. Team scrambles to verify results.</content>
      <sentiment>0.1</sentiment>
      <clueStrength>0.5</clueStrength>
      <pointsToward>true</pointsToward>
    </post>
  </posts>
</response>

CRITICAL: Return EXACTLY {{mediaCount}} posts. Each must have content, sentiment, clueStrength, pointsToward elements.

${FINAL_REMINDERS}
`.trim(),
});
