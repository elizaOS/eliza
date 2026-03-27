/**
 * Content Composition Module
 *
 * Generates and refines Moltbook content with quality iteration.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import {
  MAX_COMMENT_LENGTH,
  MAX_COMPOSE_RETRIES,
  MAX_POST_LENGTH,
  MAX_TITLE_LENGTH,
} from "../constants";
import type { CommunityContext, QualityScore } from "../types";
import { judgeContent } from "./judge";
import { getCommentPrompt, getPostPrompt } from "./templates";

export interface ComposedPost {
  title: string;
  content: string;
  qualityScore: QualityScore;
  attempts: number;
}

export interface ComposedComment {
  content: string;
  qualityScore: QualityScore;
  attempts: number;
}

/**
 * Compose a post with quality iteration
 */
export async function composePost(
  runtime: IAgentRuntime,
  context: CommunityContext,
  topic?: string,
  isAutonomous: boolean = false
): Promise<ComposedPost | null> {
  const maxRetries = isAutonomous ? MAX_COMPOSE_RETRIES : 1;

  let bestAttempt: ComposedPost | null = null;
  let feedback = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    runtime.logger.debug({ attempt, maxRetries }, "Composing Moltbook post");

    // Generate the post
    const prompt = buildComposePrompt(runtime, context, topic, feedback);
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.8, // Higher temperature for creativity
    });

    // Parse the response
    const { title, content } = parsePostResponse(response);

    if (!title || !content) {
      runtime.logger.warn({ attempt }, "Failed to parse post response");
      continue;
    }

    // Judge the quality
    const qualityScore = await judgeContent(runtime, { title, content }, context, isAutonomous);

    const result: ComposedPost = {
      title: title.slice(0, MAX_TITLE_LENGTH),
      content: content.slice(0, MAX_POST_LENGTH),
      qualityScore,
      attempts: attempt,
    };

    // Track best attempt
    if (!bestAttempt || qualityScore.overall > bestAttempt.qualityScore.overall) {
      bestAttempt = result;
    }

    // If it passes, we're done
    if (qualityScore.pass) {
      runtime.logger.info({ attempt, score: qualityScore.overall }, "Post passed quality gate");
      return result;
    }

    // Use feedback for next iteration
    feedback = qualityScore.feedback;
    runtime.logger.debug(
      { attempt, score: qualityScore.overall, feedback },
      "Post did not pass quality gate, will retry"
    );
  }

  // Return best attempt even if it didn't pass (for user-requested posts)
  if (bestAttempt && !isAutonomous) {
    runtime.logger.warn(
      { score: bestAttempt.qualityScore.overall },
      "Returning best attempt despite not passing quality gate"
    );
    return bestAttempt;
  }

  runtime.logger.warn("Failed to compose post that passes quality gate");
  return bestAttempt;
}

/**
 * Compose a comment with quality iteration
 */
export async function composeComment(
  runtime: IAgentRuntime,
  postTitle: string,
  postContent: string,
  context: CommunityContext,
  existingComments?: string[],
  isAutonomous: boolean = false
): Promise<ComposedComment | null> {
  const maxRetries = isAutonomous ? MAX_COMPOSE_RETRIES : 1;

  let bestAttempt: ComposedComment | null = null;
  let feedback = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    runtime.logger.debug({ attempt, maxRetries }, "Composing Moltbook comment");

    // Generate the comment
    const prompt = buildCommentComposePrompt(
      runtime,
      postTitle,
      postContent,
      existingComments,
      feedback
    );
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.7,
    });

    // Clean up the response (remove any formatting)
    const content = response.trim().replace(/^(COMMENT:|Comment:)\s*/i, "");

    if (!content || content.length < 10) {
      runtime.logger.warn({ attempt }, "Failed to generate meaningful comment");
      continue;
    }

    // Judge the quality
    const qualityScore = await judgeContent(
      runtime,
      { content, context: `Responding to: "${postTitle}"`, isComment: true },
      context,
      isAutonomous
    );

    const result: ComposedComment = {
      content: content.slice(0, MAX_COMMENT_LENGTH),
      qualityScore,
      attempts: attempt,
    };

    // Track best attempt
    if (!bestAttempt || qualityScore.overall > bestAttempt.qualityScore.overall) {
      bestAttempt = result;
    }

    // If it passes, we're done
    if (qualityScore.pass) {
      runtime.logger.info({ attempt, score: qualityScore.overall }, "Comment passed quality gate");
      return result;
    }

    // Use feedback for next iteration
    feedback = qualityScore.feedback;
    runtime.logger.debug(
      { attempt, score: qualityScore.overall, feedback },
      "Comment did not pass quality gate, will retry"
    );
  }

  // Return best attempt even if it didn't pass (for user-requested comments)
  if (bestAttempt && !isAutonomous) {
    return bestAttempt;
  }

  runtime.logger.warn("Failed to compose comment that passes quality gate");
  return bestAttempt;
}

/**
 * Build the composition prompt for a post
 */
function buildComposePrompt(
  runtime: IAgentRuntime,
  context: CommunityContext,
  topic?: string,
  previousFeedback?: string
): string {
  let prompt = getPostPrompt(runtime, context, topic);

  if (previousFeedback) {
    prompt += `

---
IMPORTANT: Your previous attempt received this feedback:
"${previousFeedback}"

Please address this feedback in your new attempt.
`;
  }

  return prompt;
}

/**
 * Build the composition prompt for a comment
 */
function buildCommentComposePrompt(
  runtime: IAgentRuntime,
  postTitle: string,
  postContent: string,
  existingComments?: string[],
  previousFeedback?: string
): string {
  let prompt = getCommentPrompt(runtime, postTitle, postContent, existingComments);

  if (previousFeedback) {
    prompt += `

---
IMPORTANT: Your previous attempt received this feedback:
"${previousFeedback}"

Please address this feedback in your new attempt.
`;
  }

  return prompt;
}

/**
 * Parse a post response into title and content
 */
function parsePostResponse(response: string): { title: string; content: string } {
  // Try to parse TITLE: and CONTENT: format
  const titleMatch = response.match(/TITLE:\s*(.+?)(?:\n|CONTENT:|$)/is);
  const contentMatch = response.match(/CONTENT:\s*(.+)/is);

  if (titleMatch && contentMatch) {
    return {
      title: titleMatch[1].trim(),
      content: contentMatch[1].trim(),
    };
  }

  // Fallback: try to split on double newline
  const parts = response.split(/\n\n+/);
  if (parts.length >= 2) {
    return {
      title: parts[0].trim().replace(/^(Title:|TITLE:)\s*/i, ""),
      content: parts.slice(1).join("\n\n").trim(),
    };
  }

  // Last resort: use first line as title, rest as content
  const lines = response.split("\n");
  if (lines.length >= 2) {
    return {
      title: lines[0].trim(),
      content: lines.slice(1).join("\n").trim(),
    };
  }

  return { title: "", content: response.trim() };
}

/**
 * Generate a post title from content
 */
export async function generateTitle(runtime: IAgentRuntime, content: string): Promise<string> {
  const prompt = `Generate a concise, engaging title (under 100 characters) for this Moltbook post:

${content.slice(0, 500)}

The title should:
- Be conversational, not clickbait
- Give a clear sense of what the post is about
- Feel like something a thoughtful person would say

Respond with just the title, no quotes or formatting.`;

  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    temperature: 0.6,
  });

  return response.trim().slice(0, MAX_TITLE_LENGTH);
}
