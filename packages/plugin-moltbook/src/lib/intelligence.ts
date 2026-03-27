/**
 * Community Intelligence Module
 *
 * Analyzes the Moltbook community to understand what's happening,
 * what topics are hot, and what kinds of content resonate.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { CACHE_TTL_ANALYSIS_MS } from "../constants";
import type {
  CommunityContext,
  EngagementOpportunity,
  MoltbookFeed,
  MoltbookPost,
  MoltbookProfile,
} from "../types";

/**
 * Analyze the community feed to extract context
 */
export function analyzeCommunity(feed: MoltbookFeed, runtime: IAgentRuntime): CommunityContext {
  const posts = feed.posts;

  return {
    activeTopics: extractActiveTopics(posts),
    engagementOpportunities: findEngagementOpportunities(posts, runtime),
    whatWorks: analyzeWhatWorks(posts),
    notableMoltys: findNotableMoltys(posts),
    vibe: assessCommunityVibe(posts),
    analyzedAt: Date.now(),
  };
}

/**
 * Extract trending topics from posts
 */
function extractActiveTopics(posts: MoltbookPost[]): string[] {
  // Word frequency analysis with stopwords filtered
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
    "being",
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
    "need",
    "dare",
    "ought",
    "used",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
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
    "if",
    "or",
    "because",
    "until",
    "while",
    "this",
    "that",
    "these",
    "those",
    "am",
    "it",
    "its",
    "they",
    "them",
    "their",
    "what",
    "which",
    "who",
    "whom",
    "i",
    "you",
    "he",
    "she",
    "we",
    "my",
    "your",
    "his",
    "her",
    "our",
    "me",
    "him",
    "us",
    "about",
    "like",
    "get",
    "got",
    "make",
    "made",
    "know",
    "think",
    "see",
    "come",
    "want",
    "look",
    "use",
    "find",
    "give",
    "tell",
    "work",
    "seem",
    "feel",
    "try",
    "leave",
    "call",
    "good",
    "new",
    "first",
    "last",
    "long",
    "great",
    "little",
    "own",
    "old",
    "right",
    "big",
    "high",
    "different",
    "small",
    "large",
    "next",
    "early",
    "young",
    "important",
    "few",
    "public",
    "bad",
    "same",
    "able",
    "im",
    "dont",
    "youre",
    "thats",
    "ive",
    "weve",
    "theyre",
  ]);

  const wordCounts = new Map<string, number>();

  for (const post of posts) {
    // Combine title and content
    const text = `${post.title} ${post.content}`.toLowerCase();

    // Extract words (alphanumeric only)
    const words = text.match(/\b[a-z][a-z0-9]{2,}\b/g) || [];

    for (const word of words) {
      if (!stopwords.has(word) && word.length > 2) {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }
    }
  }

  // Sort by frequency and take top topics
  const sortedWords = [...wordCounts.entries()]
    .filter(([_, count]) => count >= 2) // Appears in at least 2 posts
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);

  return sortedWords;
}

/**
 * Find posts worth engaging with
 */
function findEngagementOpportunities(
  posts: MoltbookPost[],
  runtime: IAgentRuntime
): EngagementOpportunity[] {
  const opportunities: EngagementOpportunity[] = [];
  const characterName = runtime.character.name?.toLowerCase() || "";
  const characterTopics = extractCharacterTopics(runtime);

  for (const post of posts) {
    const postText = `${post.title} ${post.content}`.toLowerCase();

    // Priority 1: Mentions of the agent or related topics
    if (
      postText.includes(characterName) ||
      postText.includes("elizaos") ||
      postText.includes("eliza")
    ) {
      opportunities.push({
        post,
        reason: "Mentions relevant topic - good opportunity to add perspective",
        type: "comment",
        priority: 10,
      });
      continue;
    }

    // Priority 2: Posts matching character interests
    const matchingTopics = characterTopics.filter((topic) =>
      postText.includes(topic.toLowerCase())
    );
    if (matchingTopics.length > 0) {
      opportunities.push({
        post,
        reason: `Relates to character interests: ${matchingTopics.join(", ")}`,
        type: "comment",
        priority: 8,
      });
      continue;
    }

    // Priority 3: Posts asking questions
    if (post.title.includes("?") || post.content.includes("?")) {
      opportunities.push({
        post,
        reason: "Post is asking a question - could provide helpful answer",
        type: "comment",
        priority: 6,
      });
      continue;
    }

    // Priority 4: High-engagement posts worth upvoting
    if (post.score > 10 && post.commentCount > 5) {
      opportunities.push({
        post,
        reason: "Popular post worth acknowledging",
        type: "upvote",
        priority: 3,
      });
    }

    // Priority 5: New users worth following
    if (post.author.postCount < 5 && post.score > 0) {
      opportunities.push({
        post,
        reason: "New community member with quality content",
        type: "follow",
        priority: 2,
      });
    }
  }

  // Sort by priority and return top opportunities
  return opportunities.sort((a, b) => b.priority - a.priority).slice(0, 10);
}

/**
 * Extract topics from character configuration
 */
function extractCharacterTopics(runtime: IAgentRuntime): string[] {
  const topics: string[] = [];

  // From character bio
  if (runtime.character.bio) {
    const bioText = Array.isArray(runtime.character.bio)
      ? runtime.character.bio.join(" ")
      : runtime.character.bio;
    // Simple keyword extraction from bio
    const keywords = bioText.match(/\b[A-Za-z][a-z]{3,}\b/g) || [];
    topics.push(...keywords.slice(0, 10));
  }

  // From character topics if defined
  if (runtime.character.topics) {
    topics.push(...runtime.character.topics);
  }

  // From character adjectives (personality traits)
  if (runtime.character.adjectives) {
    topics.push(...runtime.character.adjectives);
  }

  return [...new Set(topics)]; // Dedupe
}

/**
 * Analyze what content patterns work well
 */
function analyzeWhatWorks(posts: MoltbookPost[]): string[] {
  const patterns: string[] = [];

  // Analyze high-scoring posts
  const highScorePosts = posts.filter((p) => p.score > 5);

  if (highScorePosts.length > 0) {
    // Check average title length
    const avgTitleLength =
      highScorePosts.reduce((sum, p) => sum + p.title.length, 0) / highScorePosts.length;
    if (avgTitleLength < 50) {
      patterns.push("Concise titles (under 50 characters) perform well");
    } else if (avgTitleLength > 100) {
      patterns.push("Descriptive titles work in this community");
    }

    // Check for question posts
    const questionPosts = highScorePosts.filter((p) => p.title.includes("?"));
    if (questionPosts.length > highScorePosts.length * 0.3) {
      patterns.push("Questions engage the community");
    }

    // Check content length
    const avgContentLength =
      highScorePosts.reduce((sum, p) => sum + p.content.length, 0) / highScorePosts.length;
    if (avgContentLength < 500) {
      patterns.push("Short, punchy posts get engagement");
    } else if (avgContentLength > 1500) {
      patterns.push("In-depth content is valued");
    }
  }

  // Fallback patterns
  if (patterns.length === 0) {
    patterns.push("Share unique perspectives and experiences");
    patterns.push("Ask thought-provoking questions");
    patterns.push("Provide value in every post");
  }

  return patterns;
}

/**
 * Find notable community members
 */
function findNotableMoltys(posts: MoltbookPost[]): MoltbookProfile[] {
  const authorScores = new Map<
    string,
    { profile: MoltbookProfile; totalScore: number; postCount: number }
  >();

  for (const post of posts) {
    const existing = authorScores.get(post.authorId);
    if (existing) {
      existing.totalScore += post.score;
      existing.postCount += 1;
    } else {
      authorScores.set(post.authorId, {
        profile: post.author,
        totalScore: post.score,
        postCount: 1,
      });
    }
  }

  // Sort by engagement and return top authors
  return [...authorScores.values()]
    .filter((a) => a.postCount >= 2 || a.totalScore > 10)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 5)
    .map((a) => a.profile);
}

/**
 * Assess the overall community vibe
 */
function assessCommunityVibe(posts: MoltbookPost[]): string {
  if (posts.length === 0) {
    return "quiet - not much activity right now";
  }

  const avgScore = posts.reduce((sum, p) => sum + p.score, 0) / posts.length;
  const avgComments = posts.reduce((sum, p) => sum + p.commentCount, 0) / posts.length;

  // Check for recent activity
  const now = Date.now();
  const recentPosts = posts.filter((p) => {
    const postTime = new Date(p.createdAt).getTime();
    return now - postTime < 24 * 60 * 60 * 1000; // Last 24 hours
  });

  let vibe = "";

  if (recentPosts.length > posts.length * 0.5) {
    vibe = "active";
  } else {
    vibe = "steady";
  }

  if (avgScore > 10) {
    vibe += ", supportive";
  } else if (avgScore < 2) {
    vibe += ", discerning";
  }

  if (avgComments > 5) {
    vibe += ", conversational";
  }

  return vibe || "engaged";
}

/**
 * Check if cached analysis is still fresh
 */
export function isAnalysisFresh(
  context: CommunityContext | undefined,
  maxAgeMs: number = CACHE_TTL_ANALYSIS_MS
): boolean {
  if (!context) return false;
  return Date.now() - context.analyzedAt < maxAgeMs;
}

/**
 * Format community context for inclusion in prompts
 */
export function formatContextForPrompt(context: CommunityContext): string {
  const lines: string[] = [];

  lines.push("## Current Moltbook Community Context");
  lines.push("");

  if (context.activeTopics.length > 0) {
    lines.push(`**Hot Topics:** ${context.activeTopics.slice(0, 5).join(", ")}`);
  }

  lines.push(`**Community Vibe:** ${context.vibe}`);

  if (context.whatWorks.length > 0) {
    lines.push("");
    lines.push("**What Works Here:**");
    for (const pattern of context.whatWorks.slice(0, 3)) {
      lines.push(`- ${pattern}`);
    }
  }

  if (context.engagementOpportunities.length > 0) {
    lines.push("");
    lines.push("**Engagement Opportunities:**");
    for (const opp of context.engagementOpportunities.slice(0, 3)) {
      lines.push(`- "${opp.post.title}" - ${opp.reason}`);
    }
  }

  if (context.notableMoltys.length > 0) {
    lines.push("");
    lines.push(
      `**Notable Community Members:** ${context.notableMoltys.map((m) => m.username).join(", ")}`
    );
  }

  return lines.join("\n");
}
