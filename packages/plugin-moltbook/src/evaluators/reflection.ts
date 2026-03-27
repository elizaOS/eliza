/**
 * Moltbook Reflection Evaluator
 *
 * ## WHY AN EVALUATOR?
 *
 * Evaluators run AFTER interactions, enabling learning and reflection.
 * This evaluator processes Moltbook interactions to:
 *
 * 1. **Learn from engagement** - Did our post get upvotes? Why?
 * 2. **Track relationships** - Remember who we interacted with
 * 3. **Refine understanding** - Update cultural learnings
 * 4. **Improve future behavior** - Adjust strategy based on outcomes
 *
 * ## WHEN DOES IT RUN?
 *
 * This evaluator triggers when:
 * - A message has 'moltbook' in the source
 * - The memory metadata indicates a Moltbook interaction
 *
 * It does NOT run for every message - only Moltbook-related ones.
 */

import type { Evaluator, IAgentRuntime, Memory, State } from "@elizaos/core";
import { PLUGIN_NAME } from "../constants";
import { rememberNotableUser, storeCulturalLearning } from "../lib/learning";
import type { MoltbookService } from "../service";
import type { MoltbookProfile } from "../types";

/**
 * Evaluator that reflects on Moltbook interactions
 */
export const reflectionEvaluator: Evaluator = {
  name: "MOLTBOOK_REFLECTION",
  description:
    "Reflects on Moltbook interactions to learn about community norms, track relationships, and improve future engagement.",

  /**
   * Should we evaluate this interaction?
   *
   * WHY VALIDATE?
   * We only want to reflect on Moltbook-related interactions.
   * Running on every message would be wasteful and confusing.
   */
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    // Check if this is a Moltbook-related message
    const metadata = message.content?.metadata as Record<string, unknown> | undefined;

    // Source check
    if (message.content?.source === "moltbook") {
      return true;
    }

    // Metadata platform check
    if (metadata?.platform === "moltbook") {
      return true;
    }

    // Check for Moltbook-related actions in recent messages
    if (
      metadata?.type?.toString().startsWith("moltbook_") ||
      metadata?.action?.toString().startsWith("MOLTBOOK_")
    ) {
      return true;
    }

    return false;
  },

  /**
   * Reflect on the Moltbook interaction
   */
  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const metadata = message.content?.metadata as Record<string, unknown> | undefined;

    runtime.logger.debug(
      { metadata, source: message.content?.source },
      "Moltbook: Running reflection evaluator"
    );

    // Get the service for any follow-up operations
    const _service = runtime.getService<MoltbookService>(PLUGIN_NAME);

    // Determine what kind of interaction this was
    const interactionType = determineInteractionType(message);

    switch (interactionType) {
      case "received_comment":
        await reflectOnReceivedComment(runtime, message, metadata);
        break;

      case "made_post":
        await reflectOnMadePost(runtime, message, metadata);
        break;

      case "made_comment":
        await reflectOnMadeComment(runtime, message, metadata);
        break;

      case "observed_feed":
        await reflectOnObservedFeed(runtime, message, metadata);
        break;

      default:
        runtime.logger.debug(
          { interactionType },
          "Moltbook: Unknown interaction type for reflection"
        );
    }

    return undefined;
  },

  /**
   * Example usages for documentation
   */
  examples: [
    {
      prompt: "Reflect on receiving a comment on my Moltbook post",
      messages: [
        {
          name: "{{agentName}}",
          content: {
            text: "Processing Moltbook comment from @user123",
          },
        },
      ],
      outcome: "Learn from commenter, track relationship, note engagement",
    },
    {
      prompt: "Reflect on creating a successful Moltbook post",
      messages: [
        {
          name: "{{agentName}}",
          content: {
            text: 'Created post "My thoughts on AI" with 15 upvotes',
          },
        },
      ],
      outcome: "Store what worked, update posting strategy",
    },
  ],
};

/**
 * Determine what type of Moltbook interaction this is
 */
function determineInteractionType(
  message: Memory
): "received_comment" | "made_post" | "made_comment" | "observed_feed" | "unknown" {
  const metadata = message.content?.metadata as Record<string, unknown> | undefined;

  // Check for received comment (from mention polling)
  if (metadata?.mentionType || metadata?.commentId) {
    return "received_comment";
  }

  // Check for made post
  if (metadata?.type === "moltbook_interaction" && metadata?.interactionType === "post") {
    return "made_post";
  }

  // Check for made comment
  if (metadata?.type === "moltbook_interaction" && metadata?.interactionType === "comment") {
    return "made_comment";
  }

  // Check for feed observation
  if (metadata?.type === "moltbook_observation" || metadata?.type === "moltbook_feed") {
    return "observed_feed";
  }

  return "unknown";
}

/**
 * Reflect on receiving a comment
 *
 * WHY REFLECT ON COMMENTS?
 * Comments show someone took time to engage with us.
 * Learning from them helps us understand:
 * - What content resonates
 * - Who's interested in our topics
 * - How to improve future posts
 */
async function reflectOnReceivedComment(
  runtime: IAgentRuntime,
  _message: Memory,
  metadata: Record<string, unknown> | undefined
): Promise<void> {
  if (!metadata) return;

  const authorUsername = metadata.authorUsername as string | undefined;
  const authorId = metadata.authorId as string | undefined;
  const postTitle = metadata.postTitle as string | undefined;
  const mentionType = metadata.mentionType as string | undefined;
  const upvotes = (metadata.upvotes as number) || 0;

  runtime.logger.debug(
    { authorUsername, postTitle, mentionType },
    "Moltbook: Reflecting on received comment"
  );

  // Remember the commenter
  if (authorUsername && authorId) {
    await rememberNotableUser(
      runtime,
      {
        id: authorId,
        username: authorUsername,
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        createdAt: new Date().toISOString(),
      } as MoltbookProfile,
      mentionType === "mention" ? "Mentioned me in a comment" : "Replied to my post",
      []
    );
  }

  // Learn from engagement pattern
  if (upvotes > 5) {
    await storeCulturalLearning(
      runtime,
      "engagement",
      `High-upvote comments tend to be substantive replies`,
      [],
      0.4
    );
  }

  // If it was a mention, learn that mentions work
  if (mentionType === "mention") {
    await storeCulturalLearning(
      runtime,
      "engagement",
      "Direct @mentions get the agent's attention",
      [],
      0.3
    );
  }
}

/**
 * Reflect on making a post
 *
 * WHY REFLECT ON OUR POSTS?
 * We need to track what we post to:
 * - Avoid repetition
 * - Monitor for replies
 * - Learn what works over time
 */
async function reflectOnMadePost(
  runtime: IAgentRuntime,
  _message: Memory,
  metadata: Record<string, unknown> | undefined
): Promise<void> {
  if (!metadata) return;

  const postId = metadata.postId as string | undefined;
  const title = metadata.title as string | undefined;
  const content = metadata.content as string | undefined;

  runtime.logger.debug({ postId, title }, "Moltbook: Reflecting on made post");

  // Note: The recordMyPost function in mentions.ts handles tracking for reply monitoring
  // Here we just log for now, but could add more sophisticated analysis

  if (title && content) {
    // Extract topics from our own post
    const topics = extractTopics(`${title} ${content}`);

    await storeCulturalLearning(
      runtime,
      "topic",
      `Posted about: ${topics.slice(0, 3).join(", ")}`,
      [postId || ""],
      0.5
    );
  }
}

/**
 * Reflect on making a comment
 */
async function reflectOnMadeComment(
  runtime: IAgentRuntime,
  _message: Memory,
  metadata: Record<string, unknown> | undefined
): Promise<void> {
  if (!metadata) return;

  const postId = metadata.postId as string | undefined;
  const commentId = metadata.commentId as string | undefined;

  runtime.logger.debug({ postId, commentId }, "Moltbook: Reflecting on made comment");

  // Track that we engaged with this post
  await storeCulturalLearning(
    runtime,
    "engagement",
    "Commenting on posts helps build community presence",
    [postId || ""],
    0.3
  );
}

/**
 * Reflect on observed feed content
 */
async function reflectOnObservedFeed(
  runtime: IAgentRuntime,
  _message: Memory,
  _metadata: Record<string, unknown> | undefined
): Promise<void> {
  runtime.logger.debug("Moltbook: Reflecting on observed feed");

  // Most feed reflection happens in the cycle task's reflectOnObservations
  // This is here for completeness if individual feed items are passed through
}

/**
 * Simple topic extraction from text
 *
 * WHY NOT USE LLM?
 * This runs frequently and needs to be fast.
 * Simple keyword extraction is sufficient for basic topic tracking.
 * More sophisticated analysis can use LLM in compose/judge modules.
 */
function extractTopics(text: string): string[] {
  // Common stopwords to filter out
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "this",
    "that",
    "these",
    "those",
    "i",
    "you",
    "he",
    "she",
    "it",
    "we",
    "they",
    "what",
    "which",
    "who",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "and",
    "but",
    "or",
    "if",
    "because",
    "as",
    "until",
    "while",
    "of",
    "at",
    "by",
    "for",
    "with",
    "about",
    "against",
    "between",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "to",
    "from",
    "up",
    "down",
    "in",
    "out",
    "on",
    "off",
  ]);

  // Extract words, filter, and count
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopwords.has(w));

  // Count occurrences
  const counts = new Map<string, number>();
  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  // Return top topics by frequency
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

export default reflectionEvaluator;
