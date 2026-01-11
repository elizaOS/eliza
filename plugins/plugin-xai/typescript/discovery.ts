import {
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import type { Client, Post } from "./client/index";
import { SearchMode } from "./client/index";
import { getRandomInterval } from "./environment";
import { createMemorySafe, ensureXContext } from "./utils/memory";
import { getSetting } from "./utils/settings";

interface DiscoveryConfig {
  // Topics from character configuration
  topics: string[];
  // Minimum follower count for accounts to consider
  minFollowerCount: number;
  // Maximum accounts to follow per cycle
  maxFollowsPerCycle: number;
  // Maximum engagements per cycle
  maxEngagementsPerCycle: number;
  // Engagement probability thresholds
  likeThreshold: number;
  replyThreshold: number;
  quoteThreshold: number;
}

interface ScoredPost {
  post: Post;
  relevanceScore: number;
  engagementType: "like" | "reply" | "quote" | "skip";
}

interface ScoredAccount {
  user: {
    id: string;
    username: string;
    name: string;
    followersCount: number;
  };
  qualityScore: number;
  relevanceScore: number;
}

export class XDiscoveryClient {
  private xClient: Client;
  private runtime: IAgentRuntime;
  private config: DiscoveryConfig;
  private isRunning: boolean = false;
  private isDryRun: boolean;

  constructor(client: ClientBase, runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.xClient = client.xClient;
    this.runtime = runtime;

    // Check dry run mode
    const dryRunSetting =
      state?.X_DRY_RUN ?? getSetting(this.runtime, "X_DRY_RUN") ?? process.env.X_DRY_RUN;
    this.isDryRun =
      dryRunSetting === true ||
      dryRunSetting === "true" ||
      (typeof dryRunSetting === "string" && dryRunSetting.toLowerCase() === "true");

    // Build config from character settings
    this.config = this.buildDiscoveryConfig();

    logger.info(
      `X Discovery Config: topics=${this.config.topics.join(", ")}, isDryRun=${this.isDryRun}, minFollowerCount=${this.config.minFollowerCount}, maxFollowsPerCycle=${this.config.maxFollowsPerCycle}, maxEngagementsPerCycle=${this.config.maxEngagementsPerCycle}`
    );
  }

  /**
   * Sanitizes a topic for use in X search queries
   * - Removes common stop words that might be interpreted as operators
   * - Handles special characters
   * - Simplifies complex phrases
   */
  private sanitizeTopic(topic: string): string {
    // Remove common conjunctions that might be interpreted as operators
    let sanitized = topic
      .replace(/\band\b/gi, " ")
      .replace(/\bor\b/gi, " ")
      .replace(/\bnot\b/gi, " ")
      .trim();

    // Remove extra spaces
    sanitized = sanitized.replace(/\s+/g, " ");

    // If the topic is still multi-word, wrap in quotes
    return sanitized.includes(" ") ? `"${sanitized}"` : sanitized;
  }

  private buildDiscoveryConfig(): DiscoveryConfig {
    const character = this.runtime?.character;

    // Default topics if character is not available
    const defaultTopics = [
      "ai",
      "technology",
      "blockchain",
      "web3",
      "crypto",
      "programming",
      "innovation",
    ];

    // Use character topics, extract from bio, or use defaults
    let topics: string[] = defaultTopics;

    if (character) {
      if (character.topics && Array.isArray(character.topics) && character.topics.length > 0) {
        topics = character.topics;
      } else if (character.bio) {
        topics = this.extractTopicsFromBio(character.bio);
      }
    } else {
      logger.warn("Character not available in runtime, using default topics for discovery");
    }

    return {
      topics,
      minFollowerCount: parseInt(
        (getSetting(this.runtime, "X_MIN_FOLLOWER_COUNT") as string) ||
          process.env.X_MIN_FOLLOWER_COUNT ||
          "100",
        10
      ),
      maxFollowsPerCycle: parseInt(
        (getSetting(this.runtime, "X_MAX_FOLLOWS_PER_CYCLE") as string) ||
          process.env.X_MAX_FOLLOWS_PER_CYCLE ||
          "5",
        10
      ),
      maxEngagementsPerCycle: parseInt(
        (getSetting(this.runtime, "X_MAX_ENGAGEMENTS_PER_RUN") as string) ||
          process.env.X_MAX_ENGAGEMENTS_PER_RUN ||
          "5",
        10
      ),
      likeThreshold: 0.5, // Increased from 0.3 (be more selective)
      replyThreshold: 0.7, // Increased from 0.5 (be more selective)
      quoteThreshold: 0.85, // Increased from 0.7 (be more selective)
    };
  }

  private extractTopicsFromBio(bio: string | string[] | undefined): string[] {
    if (!bio) {
      return [];
    }

    const bioText = Array.isArray(bio) ? bio.join(" ") : bio;
    // Extract meaningful words as potential topics
    const words = bioText
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 4)
      .filter(
        (word) => !["about", "helping", "working", "people", "making", "building"].includes(word)
      );
    return [...new Set(words)].slice(0, 5); // Limit to 5 topics
  }

  async start() {
    logger.info("Starting X Discovery Client...");
    this.isRunning = true;

    const discoveryLoop = async () => {
      if (!this.isRunning) {
        logger.info("Discovery client stopped, exiting loop");
        return;
      }

      try {
        await this.runDiscoveryCycle();
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error("Discovery cycle error:", errorMsg);
      }

      // Run discovery every 20-40 minutes (with variance)
      const discoveryIntervalMinutes = getRandomInterval(this.runtime, "discovery");
      const nextInterval = discoveryIntervalMinutes * 60 * 1000;

      logger.log(`Next discovery cycle in ${discoveryIntervalMinutes.toFixed(1)} minutes`);

      // Schedule next discovery
      setTimeout(discoveryLoop, nextInterval);
    };

    // Start after a short delay
    setTimeout(discoveryLoop, 5000);
  }

  async stop() {
    logger.info("Stopping X Discovery Client...");
    this.isRunning = false;
  }

  private async runDiscoveryCycle() {
    logger.info("Starting X discovery cycle...");

    const discoveries = await this.discoverContent();
    const { posts, accounts } = discoveries;

    logger.info(`Discovered ${posts.length} posts and ${accounts.length} accounts`);

    // Process discovered accounts (follow high-quality ones)
    const followedCount = await this.processAccounts(accounts);

    // Process discovered posts (engage with relevant ones)
    const engagementCount = await this.processPosts(posts);

    logger.info(
      `Discovery cycle complete: ${followedCount} follows, ${engagementCount} engagements`
    );
  }

  private async discoverContent(): Promise<{
    posts: ScoredPost[];
    accounts: ScoredAccount[];
  }> {
    const allPosts: ScoredPost[] = [];
    const allAccounts = new Map<string, ScoredAccount>();

    // X API v2 doesn't support trends - using topic-based discovery only

    // 1. Discover from topic searches (primary discovery method)
    try {
      const topicContent = await this.discoverFromTopics();
      allPosts.push(...topicContent.posts);
      for (const acc of topicContent.accounts) {
        allAccounts.set(acc.user.id, acc);
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to discover from topics:", errorMsg);
    }

    // 2. Discover from conversation threads
    try {
      const threadContent = await this.discoverFromThreads();
      allPosts.push(...threadContent.posts);
      for (const acc of threadContent.accounts) {
        allAccounts.set(acc.user.id, acc);
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to discover from threads:", errorMsg);
    }

    // 3. Discover from popular accounts in our topics
    try {
      const popularContent = await this.discoverFromPopularAccounts();
      allPosts.push(...popularContent.posts);
      for (const acc of popularContent.accounts) {
        allAccounts.set(acc.user.id, acc);
      }
    } catch (error) {
      logger.error(
        "Failed to discover from popular accounts:",
        error instanceof Error ? error.message : String(error)
      );
    }

    // Sort by relevance score
    const sortedPosts = allPosts.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 50); // Top 50 posts

    const sortedAccounts = Array.from(allAccounts.values())
      .sort((a, b) => b.qualityScore * b.relevanceScore - a.qualityScore * a.relevanceScore)
      .slice(0, 20); // Top 20 accounts

    return { posts: sortedPosts, accounts: sortedAccounts };
  }

  private async discoverFromTopics(): Promise<{
    posts: ScoredPost[];
    accounts: ScoredAccount[];
  }> {
    logger.debug("Discovering from character topics...");

    const posts: ScoredPost[] = [];
    const accounts = new Map<string, ScoredAccount>();

    // Search for each topic with different query strategies
    for (const topic of this.config.topics.slice(0, 5)) {
      try {
        // Sanitize topic for search query
        const searchTopic = this.sanitizeTopic(topic);

        // Strategy 1: Popular posts in topic (min_faves filter applied post-retrieval)
        const popularQuery = `${searchTopic} -is:repost -is:reply lang:en`;

        logger.debug(`Searching popular posts for topic: ${topic}`);
        const popularResults = await this.xClient.fetchSearchPosts(
          popularQuery,
          20,
          SearchMode.Top
        );

        for (const post of popularResults.posts) {
          // Filter by engagement after retrieval
          if ((post.likes || 0) < 10) continue;

          const scored = this.scorePost(post, "topic");
          posts.push(scored);

          // Extract account info from popular post authors
          if (!post.userId || !post.username) {
            continue;
          }
          const authorUsername = post.username;
          const authorName = post.name || post.username;

          // Estimate follower count based on post engagement
          // Popular posts often come from accounts with decent followings
          const estimatedFollowers = Math.max(
            1000, // minimum estimate
            (post.likes || 0) * 100 // rough estimate: 100 followers per like
          );

          const account = this.scoreAccount({
            id: post.userId,
            username: authorUsername,
            name: authorName,
            followersCount: estimatedFollowers,
          });

          if (account.qualityScore > 0.3) {
            // Lower threshold to discover more accounts
            accounts.set(post.userId, account);
          }
        }

        // Strategy 2: Latest posts with good engagement (not just verified)
        const engagedQuery = `${searchTopic} -is:repost lang:en`;

        logger.debug(`Searching engaged posts for topic: ${topic}`);
        const engagedResults = await this.xClient.fetchSearchPosts(
          engagedQuery,
          15,
          SearchMode.Latest
        );

        for (const post of engagedResults.posts) {
          // Only include posts with some engagement
          if ((post.likes || 0) < 5) continue;

          const scored = this.scorePost(post, "topic");
          posts.push(scored);

          // Extract account info from post author
          if (!post.userId || !post.username) {
            continue;
          }
          const authorUsername = post.username;
          const authorName = post.name || post.username;

          // Estimate follower count based on engagement
          const estimatedFollowers = Math.max(
            500, // minimum for engaged posts
            (post.likes || 0) * 50
          );

          const account = this.scoreAccount({
            id: post.userId,
            username: authorUsername,
            name: authorName,
            followersCount: estimatedFollowers,
          });

          if (account.qualityScore > 0.2) {
            // Even lower threshold for engaged content
            accounts.set(post.userId, account);
          }
        }
      } catch (error) {
        logger.error(
          `Failed to search topic ${topic}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return { posts, accounts: Array.from(accounts.values()) };
  }

  private async discoverFromThreads(): Promise<{
    posts: ScoredPost[];
    accounts: ScoredAccount[];
  }> {
    logger.debug("Discovering from conversation threads...");

    const posts: ScoredPost[] = [];
    const accounts = new Map<string, ScoredAccount>();

    // Search for viral conversations in our topics
    // X API v2 doesn't support min_replies/min_faves - filter by engagement in scoring
    const topicQuery = this.config.topics
      .slice(0, 3)
      .map((t) => this.sanitizeTopic(t))
      .join(" OR ");

    try {
      // Search for conversations (posts with engagement)
      const viralQuery = `(${topicQuery}) -is:repost has:mentions`;

      logger.debug(`Searching viral threads with query: ${viralQuery}`);
      const searchResults = await this.xClient.fetchSearchPosts(viralQuery, 15, SearchMode.Top);

      for (const post of searchResults.posts) {
        // Filter for posts with good engagement (proxy for viral threads)
        const engagementScore = (post.likes || 0) + (post.reposts || 0) * 2;
        if (engagementScore < 10) continue; // Lowered from 50 - more inclusive

        const scored = this.scorePost(post, "thread");
        posts.push(scored);

        // Viral thread authors are likely high-quality accounts
        if (!post.userId || !post.username) {
          continue;
        }
        const account = this.scoreAccount({
          id: post.userId,
          username: post.username,
          name: post.name || post.username,
          followersCount: 1000, // Reasonable estimate for engaged users
        });

        if (account.qualityScore > 0.5) {
          // Lowered from 0.6
          accounts.set(post.userId, account);
        }
      }
    } catch (error) {
      logger.error(
        "Failed to discover threads:",
        error instanceof Error ? error.message : String(error)
      );
    }

    return { posts, accounts: Array.from(accounts.values()) };
  }

  private async discoverFromPopularAccounts(): Promise<{
    posts: ScoredPost[];
    accounts: ScoredAccount[];
  }> {
    logger.debug("Discovering from popular accounts in topics...");

    const posts: ScoredPost[] = [];
    const accounts = new Map<string, ScoredAccount>();

    // Search for users who frequently post about our topics
    for (const topic of this.config.topics.slice(0, 3)) {
      try {
        // Sanitize topic for search query
        const searchTopic = this.sanitizeTopic(topic);

        // Find posts from accounts with high engagement
        // X API v2 doesn't support min_faves/min_reposts - filter post-retrieval
        const influencerQuery = `${searchTopic} -is:repost lang:en`;

        logger.debug(`Searching for influencers in topic: ${topic}`);
        const results = await this.xClient.fetchSearchPosts(influencerQuery, 10, SearchMode.Top);

        for (const post of results.posts) {
          // Filter by engagement metrics after retrieval
          const engagement = (post.likes || 0) + (post.reposts || 0) * 2;
          if (engagement < 5) continue; // Lowered from 20 - more inclusive

          const scored = this.scorePost(post, "topic");
          posts.push(scored);

          // High engagement suggests a quality account
          const estimatedFollowers = Math.max(
            (post.likes || 0) * 100,
            (post.reposts || 0) * 200,
            10000
          );

          if (!post.userId || !post.username) {
            continue;
          }
          const account = this.scoreAccount({
            id: post.userId,
            username: post.username,
            name: post.name || post.username,
            followersCount: estimatedFollowers,
          });

          if (account.qualityScore > 0.7) {
            accounts.set(post.userId, account);
          }
        }
      } catch (error) {
        logger.error(
          `Failed to discover popular accounts for ${topic}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return { posts, accounts: Array.from(accounts.values()) };
  }

  // Remove the discoverFromTrends method since API v2 doesn't support it
  // Remove the isTrendRelevant method since we're not using trends

  private scorePost(post: Post, source: string): ScoredPost {
    // Skip reposts - we want original content
    if (post.isRepost) {
      return {
        post,
        relevanceScore: 0,
        engagementType: "skip",
      };
    }

    let relevanceScore = 0;

    // Base score by source
    const sourceScores: Record<string, number> = {
      topic: 0.4,
      thread: 0.35,
    };
    relevanceScore += sourceScores[source] || 0;

    // Score by engagement metrics - much more realistic thresholds
    const engagementScore = Math.min(
      (post.likes || 0) / 100 + // 100 likes = 0.1 points (was 1000)
        (post.reposts || 0) / 50 + // 50 reposts = 0.1 points (was 500)
        (post.replies || 0) / 20, // 20 replies = 0.1 points (was 100)
      0.3
    );
    relevanceScore += engagementScore;

    // Score by text relevance if text exists
    if (post.text) {
      // Additional scoring based on text content can go here
    }

    // Score by content relevance to topics
    if (post.text) {
      const textLower = post.text.toLowerCase();
      const topicMatches = this.config.topics.filter((topic) =>
        textLower.includes(topic.toLowerCase())
      ).length;
      relevanceScore += Math.min(topicMatches * 0.15, 0.3); // Increased from 0.1
    }

    // Bonus for verified accounts (isBlueVerified may not be in all responses)

    // Normalize score
    relevanceScore = Math.min(relevanceScore, 1);

    // Determine engagement type based on score
    let engagementType: ScoredPost["engagementType"] = "skip";
    if (relevanceScore >= this.config.quoteThreshold) {
      engagementType = "quote";
    } else if (relevanceScore >= this.config.replyThreshold) {
      engagementType = "reply";
    } else if (relevanceScore >= this.config.likeThreshold) {
      engagementType = "like";
    }

    return {
      post,
      relevanceScore,
      engagementType,
    };
  }

  private scoreAccount(user: ScoredAccount["user"]): ScoredAccount {
    let qualityScore = 0;
    let relevanceScore = 0;

    // Quality based on follower count
    if (user.followersCount > 10000) qualityScore += 0.4;
    else if (user.followersCount > 1000) qualityScore += 0.3;
    else if (user.followersCount > 100) qualityScore += 0.2;

    // Relevance based on username/name matching topics
    const userText = `${user.username} ${user.name}`.toLowerCase();
    const topicMatches = this.config.topics.filter((topic) =>
      userText.includes(topic.toLowerCase())
    ).length;
    relevanceScore = Math.min(topicMatches * 0.3, 1);

    return {
      user,
      qualityScore: Math.min(qualityScore, 1),
      relevanceScore,
    };
  }

  private async processAccounts(accounts: ScoredAccount[]): Promise<number> {
    let followedCount = 0;

    // Sort accounts by combined quality and relevance score
    const sortedAccounts = accounts.sort((a, b) => {
      const scoreA = a.qualityScore + a.relevanceScore;
      const scoreB = b.qualityScore + b.relevanceScore;
      return scoreB - scoreA;
    });

    for (const scoredAccount of sortedAccounts) {
      if (followedCount >= this.config.maxFollowsPerCycle) break;

      // Skip accounts with too few followers
      if (scoredAccount.user.followersCount < this.config.minFollowerCount) {
        logger.debug(
          `Skipping @${scoredAccount.user.username} - below minimum follower count (${scoredAccount.user.followersCount} < ${this.config.minFollowerCount})`
        );
        continue;
      }

      // Skip low-quality accounts
      if (scoredAccount.qualityScore < 0.2) {
        logger.debug(
          `Skipping @${scoredAccount.user.username} - quality score too low (${scoredAccount.qualityScore.toFixed(2)})`
        );
        continue;
      }

      try {
        // Check if already following (via memory)
        const isFollowing = await this.checkIfFollowing(scoredAccount.user.id);
        if (isFollowing) continue;

        if (this.isDryRun) {
          logger.info(
            `[DRY RUN] Would follow @${scoredAccount.user.username} ` +
              `(quality: ${scoredAccount.qualityScore.toFixed(2)}, ` +
              `relevance: ${scoredAccount.relevanceScore.toFixed(2)})`
          );
        } else {
          // Follow the account
          await this.xClient.followUser(scoredAccount.user.id);

          logger.info(
            `Followed @${scoredAccount.user.username} ` +
              `(quality: ${scoredAccount.qualityScore.toFixed(2)}, ` +
              `relevance: ${scoredAccount.relevanceScore.toFixed(2)})`
          );

          // Save follow action to memory
          await this.saveFollowMemory(scoredAccount.user);
        }

        followedCount++;

        // Add a delay to avoid rate limits
        await this.delay(2000 + Math.random() * 3000);
      } catch (error) {
        logger.error(
          `Failed to follow @${scoredAccount.user.username}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return followedCount;
  }

  private async processPosts(posts: ScoredPost[]): Promise<number> {
    let engagementCount = 0;

    for (const scoredPost of posts) {
      if (engagementCount >= this.config.maxEngagementsPerCycle) break;
      if (scoredPost.engagementType === "skip") continue;

      try {
        // Check if already engaged
        if (!scoredPost.post.id) {
          continue;
        }
        const postMemoryId = createUniqueUuid(this.runtime, scoredPost.post.id);
        const existingMemory = await this.runtime.getMemoryById(postMemoryId);
        if (existingMemory) {
          logger.debug(`Already engaged with post ${scoredPost.post.id}, skipping`);
          continue;
        }

        // Perform engagement
        switch (scoredPost.engagementType) {
          case "like":
            if (this.isDryRun) {
              logger.info(
                `[DRY RUN] Would like post: ${scoredPost.post.id} (score: ${scoredPost.relevanceScore.toFixed(2)})`
              );
            } else {
              if (!scoredPost.post.id) {
                continue;
              }
              await this.xClient.likePost(scoredPost.post.id);
              logger.info(
                `Liked post: ${scoredPost.post.id} (score: ${scoredPost.relevanceScore.toFixed(2)})`
              );
            }
            break;

          case "reply": {
            const replyText = await this.generateReply(scoredPost.post);
            if (this.isDryRun) {
              logger.info(
                `[DRY RUN] Would reply to post ${scoredPost.post.id} with: "${replyText}"`
              );
            } else {
              await this.xClient.sendPost(replyText, scoredPost.post.id);
              logger.info(`Replied to post: ${scoredPost.post.id}`);
            }
            break;
          }

          case "quote": {
            if (!scoredPost.post.id) {
              continue;
            }
            const quoteText = await this.generateQuote(scoredPost.post);
            if (this.isDryRun) {
              logger.info(`[DRY RUN] Would quote post ${scoredPost.post.id} with: "${quoteText}"`);
            } else {
              await this.xClient.sendQuotePost(quoteText, scoredPost.post.id);
              logger.info(`Quoted post: ${scoredPost.post.id}`);
            }
            break;
          }
        }

        // Save engagement to memory (even in dry run for tracking)
        await this.saveEngagementMemory(scoredPost.post, scoredPost.engagementType);

        engagementCount++;

        // Add delay to avoid rate limits
        await this.delay(3000 + Math.random() * 5000);
      } catch (error: unknown) {
        // Check if it's a 403 error
        const errorMessage = (error as { message?: string })?.message;
        if (errorMessage?.includes("403")) {
          logger.warn(
            `Permission denied (403) for post ${scoredPost.post.id}. ` +
              `This might be a protected account or restricted post. Skipping.`
          );
          // Still save to memory to avoid retrying
          await this.saveEngagementMemory(scoredPost.post, "skip");
        } else if (errorMessage?.includes("429")) {
          logger.warn(
            `Rate limit (429) hit while engaging with post ${scoredPost.post.id}. ` +
              `Pausing engagement cycle.`
          );
          // Break out of the loop on rate limit
          break;
        } else {
          logger.error(
            `Failed to engage with post ${scoredPost.post.id}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }

    return engagementCount;
  }

  private async checkIfFollowing(userId: string): Promise<boolean> {
    // Check our memory to see if we've followed them
    const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: `followed X user ${userId}`,
    });

    const followMemories = await this.runtime.searchMemories({
      tableName: "messages",
      embedding,
      match_threshold: 0.8,
      count: 1,
    });
    return followMemories.length > 0;
  }

  private async generateReply(post: Post): Promise<string> {
    // Handle case where runtime.character might be undefined
    const characterName = this.runtime?.character?.name || "AI Assistant";
    let characterBio = "";

    if (this.runtime?.character?.bio) {
      if (Array.isArray(this.runtime.character.bio)) {
        characterBio = this.runtime.character.bio.join(" ");
      } else {
        characterBio = this.runtime.character.bio;
      }
    }

    const prompt = `You are ${characterName}. Generate a thoughtful reply to this post:

Post by @${post.username || "unknown"}: "${post.text || ""}"

Your interests: ${this.config.topics.join(", ")}
Character bio: ${characterBio}

Keep the reply:
- Relevant and adding value to the conversation
- Under 280 characters
- Natural and conversational
- Related to your expertise and interests
- Respectful and constructive

Reply:`;

    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 100,
      temperature: 0.8,
    });

    return response.trim();
  }

  private async generateQuote(post: Post): Promise<string> {
    // Handle case where runtime.character might be undefined
    const characterName = this.runtime?.character?.name || "AI Assistant";
    let characterBio = "";

    if (this.runtime?.character?.bio) {
      if (Array.isArray(this.runtime.character.bio)) {
        characterBio = this.runtime.character.bio.join(" ");
      } else {
        characterBio = this.runtime.character.bio;
      }
    }

    const prompt = `You are ${characterName}. Add your perspective to this post with a quote post:

Original post by @${post.username || "unknown"}: "${post.text || ""}"

Your interests: ${this.config.topics.join(", ")}
Character bio: ${characterBio}

Create a quote post that:
- Adds unique insight or perspective
- Is under 280 characters
- Respectfully builds on the original idea
- Showcases your expertise
- Encourages further discussion

Quote post:`;

    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 100,
      temperature: 0.8,
    });

    return response.trim();
  }

  private async saveEngagementMemory(post: Post, engagementType: string) {
    try {
      // Ensure context exists before saving memory
      if (!post.userId || !post.username) {
        logger.warn("Cannot ensure context: missing userId or username");
        return;
      }
      const context = await ensureXContext(this.runtime, {
        userId: post.userId,
        username: post.username,
        conversationId: post.conversationId || post.id || "",
      });

      const memory: Memory = {
        id: createUniqueUuid(this.runtime, `${post.id}-${engagementType}`),
        entityId: context.entityId,
        content: {
          text: `${engagementType} post from @${post.username}: ${post.text}`,
          metadata: {
            postId: post.id,
            engagementType,
            source: "discovery",
            isDryRun: this.isDryRun,
          },
        },
        roomId: context.roomId,
        agentId: this.runtime.agentId,
        createdAt: Date.now(),
      };

      await createMemorySafe(this.runtime, memory, "messages");
      logger.debug(`[Discovery] Saved ${engagementType} memory for post ${post.id}`);
    } catch (error) {
      logger.error(
        `[Discovery] Failed to save engagement memory:`,
        error instanceof Error ? error.message : String(error)
      );
      // Don't throw - just log the error
    }
  }

  private async saveFollowMemory(user: ScoredAccount["user"]) {
    try {
      // Create a simple context for follows
      const context = await ensureXContext(this.runtime, {
        userId: user.id,
        username: user.username,
        name: user.name,
        conversationId: `x-follows`,
      });

      const memory: Memory = {
        id: createUniqueUuid(this.runtime, `follow-${user.id}`),
        entityId: context.entityId,
        content: {
          text: `followed X user ${user.id} @${user.username}`,
          metadata: {
            userId: user.id,
            username: user.username,
            name: user.name,
            followersCount: user.followersCount,
            source: "discovery",
            isDryRun: this.isDryRun,
          },
        },
        roomId: context.roomId,
        agentId: this.runtime.agentId,
        createdAt: Date.now(),
      };

      await createMemorySafe(this.runtime, memory, "messages");
      logger.debug(`[Discovery] Saved follow memory for @${user.username}`);
    } catch (error) {
      logger.error(
        `[Discovery] Failed to save follow memory:`,
        error instanceof Error ? error.message : String(error)
      );
      // Don't throw - just log the error
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
