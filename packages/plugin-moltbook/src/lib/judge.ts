/**
 * Quality Gate - Content Judging
 *
 * Multi-criteria quality assessment for Moltbook content.
 * Ensures posts meet quality standards before publishing.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { MIN_QUALITY_SCORE_AUTONOMOUS, MIN_QUALITY_SCORE_USER } from "../constants";
import type { CommunityContext, ContentToJudge, QualityScore } from "../types";

/**
 * Judge content quality using LLM
 */
export async function judgeContent(
  runtime: IAgentRuntime,
  content: ContentToJudge,
  context?: CommunityContext,
  isAutonomous: boolean = false
): Promise<QualityScore> {
  const characterName = runtime.character.name || "Agent";
  const minScore = isAutonomous ? MIN_QUALITY_SCORE_AUTONOMOUS : MIN_QUALITY_SCORE_USER;

  // Build the judging prompt
  const prompt = buildJudgePrompt(content, characterName, context);

  try {
    // Use TEXT_LARGE for more nuanced judgment on autonomous posts
    const modelType = isAutonomous ? ModelType.TEXT_LARGE : ModelType.TEXT_SMALL;

    const response = await runtime.useModel(modelType, {
      prompt,
      temperature: 0.3, // Lower temperature for consistent scoring
    });

    // Parse the response
    return parseJudgeResponse(response, minScore);
  } catch (error) {
    runtime.logger.error({ error }, "Error judging content quality");

    // Return failing score on error
    return {
      relevance: 0,
      interestingness: 0,
      originality: 0,
      voice: 0,
      value: 0,
      overall: 0,
      feedback: "Failed to evaluate content quality",
      pass: false,
    };
  }
}

/**
 * Build the prompt for judging content
 */
function buildJudgePrompt(
  content: ContentToJudge,
  characterName: string,
  context?: CommunityContext
): string {
  const contentType = content.isComment ? "comment" : "post";

  let contextInfo = "";
  if (context) {
    contextInfo = `
Current Community Context:
- Hot topics: ${context.activeTopics.slice(0, 5).join(", ") || "various"}
- Community vibe: ${context.vibe}
- What works: ${context.whatWorks[0] || "quality content"}
`;
  }

  const fullContent = content.title
    ? `Title: ${content.title}\n\nContent: ${content.content}`
    : content.content;

  return `You are a quality judge for Moltbook, a social network for AI agents. Evaluate this ${contentType} from ${characterName}.

${contextInfo}

${content.context ? `Context for this ${contentType}: ${content.context}\n` : ""}

--- BEGIN ${contentType.toUpperCase()} ---
${fullContent}
--- END ${contentType.toUpperCase()} ---

Rate this ${contentType} on each criterion (1-10):

1. RELEVANCE: Is this relevant to the Moltbook community? Does it fit what people discuss here?
2. INTERESTINGNESS: Would someone want to read this? Does it capture attention?
3. ORIGINALITY: Is this a fresh perspective? Does it add something new?
4. VOICE: Does this feel authentic to ${characterName}'s character? Is it natural, not forced?
5. VALUE: Does this add value? Would reading this be worth someone's time?

Respond in exactly this format:
RELEVANCE: [1-10]
INTERESTINGNESS: [1-10]
ORIGINALITY: [1-10]
VOICE: [1-10]
VALUE: [1-10]
FEEDBACK: [One specific suggestion for improvement, or "Ready to post" if excellent]

Be honest and critical. A 7 should mean "good enough to post", 9-10 is exceptional.`;
}

/**
 * Parse the judge response into a QualityScore
 */
function parseJudgeResponse(response: string, minScore: number): QualityScore {
  // Default values in case parsing fails
  const scores: QualityScore = {
    relevance: 5,
    interestingness: 5,
    originality: 5,
    voice: 5,
    value: 5,
    overall: 5,
    feedback: "Unable to parse feedback",
    pass: false,
  };

  try {
    // Parse each score
    const relevanceMatch = response.match(/RELEVANCE:\s*(\d+)/i);
    const interestingnessMatch = response.match(/INTERESTINGNESS:\s*(\d+)/i);
    const originalityMatch = response.match(/ORIGINALITY:\s*(\d+)/i);
    const voiceMatch = response.match(/VOICE:\s*(\d+)/i);
    const valueMatch = response.match(/VALUE:\s*(\d+)/i);
    const feedbackMatch = response.match(/FEEDBACK:\s*(.+?)(?:\n|$)/i);

    if (relevanceMatch)
      scores.relevance = Math.min(10, Math.max(1, parseInt(relevanceMatch[1], 10)));
    if (interestingnessMatch)
      scores.interestingness = Math.min(10, Math.max(1, parseInt(interestingnessMatch[1], 10)));
    if (originalityMatch)
      scores.originality = Math.min(10, Math.max(1, parseInt(originalityMatch[1], 10)));
    if (voiceMatch) scores.voice = Math.min(10, Math.max(1, parseInt(voiceMatch[1], 10)));
    if (valueMatch) scores.value = Math.min(10, Math.max(1, parseInt(valueMatch[1], 10)));
    if (feedbackMatch) scores.feedback = feedbackMatch[1].trim();

    // Calculate overall score (weighted average)
    scores.overall = Math.round(
      (scores.relevance * 1.0 +
        scores.interestingness * 1.5 +
        scores.originality * 1.0 +
        scores.voice * 1.5 +
        scores.value * 1.0) /
        6.0
    );

    // Determine if it passes
    scores.pass = scores.overall >= minScore;
  } catch (_error) {
    // Keep default values on parse error
  }

  return scores;
}

/**
 * Quick quality check for user-requested posts
 * Uses TEXT_SMALL for faster response
 */
export async function quickQualityCheck(
  runtime: IAgentRuntime,
  content: ContentToJudge
): Promise<{ pass: boolean; reason: string }> {
  const characterName = runtime.character.name || "Agent";

  const prompt = `Quick quality check for a Moltbook post from ${characterName}:

${content.title ? `Title: ${content.title}\n` : ""}Content: ${content.content.slice(0, 500)}

Does this post:
1. Sound authentic to ${characterName}?
2. Add value to a conversation?
3. Avoid being spammy, low-effort, or inappropriate?

Respond with: PASS or FAIL
Then briefly explain why in one sentence.`;

  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.2,
    });

    const pass = response.toUpperCase().includes("PASS");
    const reasonMatch = response.match(/(?:PASS|FAIL)[:\s]*(.+)/i);
    const reason = reasonMatch
      ? reasonMatch[1].trim()
      : pass
        ? "Content meets quality standards"
        : "Content does not meet quality standards";

    return { pass, reason };
  } catch (error) {
    runtime.logger.error({ error }, "Error in quick quality check");
    return { pass: true, reason: "Quality check skipped due to error" };
  }
}

/**
 * Format quality score for display
 */
export function formatQualityScore(score: QualityScore): string {
  const emoji = score.pass ? "✅" : "❌";
  return `${emoji} Quality Score: ${score.overall}/10
  - Relevance: ${score.relevance}/10
  - Interestingness: ${score.interestingness}/10
  - Originality: ${score.originality}/10
  - Voice: ${score.voice}/10
  - Value: ${score.value}/10
  
Feedback: ${score.feedback}`;
}
