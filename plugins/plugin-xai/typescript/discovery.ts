import type { ClientBase } from "./base";
import type { Client, Tweet } from "./client/index";
import {
  type IAgentRuntime,
  createUniqueUuid,
  logger,
  ModelType,
  type Memory,
} from "@elizaos/core";
import { SearchMode } from "./client/index";
import { getSetting } from "./utils/settings";
import { getRandomInterval } from "./environment";
import {
  ensureTwitterContext,
  createMemorySafe
} from "./utils/memory";

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

interface ScoredTweet {
  tweet: Tweet;
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

export class TwitterDiscoveryClient {
  private client: ClientBase;
  private twitterClient: Client;
  private runtime: IAgentRuntime;
  private config: DiscoveryConfig;
  private isRunning: boolean = false;
  private isDryRun: boolean;
  private lastDiscoveryTime: number = 0;
  private state: any;

  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.twitterClient = client.twitterClient;
    this.runtime = runtime;
    this.state = state;

    // Check dry run mode
    const dryRunSetting =
      state?.TWITTER_DRY_RUN ??
      getSetting(this.runtime, "TWITTER_DRY_RUN") ??
      process.env.TWITTER_DRY_RUN;
    this.isDryRun =
      dryRunSetting === true ||
      dryRunSetting === "true" ||
      (typeof dryRunSetting === "string" &&
        dryRunSetting.toLowerCase() === "true");

    // Build config from character settings
    this.config = this.buildDiscoveryConfig();

    logger.info("Twitter Discovery Config:", {
      topics: this.config.topics,
      isDryRun: this.isDryRun,
      minFollowerCount: this.config.minFollowerCount,
      maxFollowsPerCycle: this.config.maxFollowsPerCycle,
      maxEngagementsPerCycle: this.config.maxEngagementsPerCycle,
    });
  }

  /**
   * Sanitizes a topic for use in Twitter search queries
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
      if (
        character.topics &&
        Array.isArray(character.topics) &&
        character.topics.length > 0
      ) {
        topics = character.topics;
      } else if (character.bio) {
        topics = this.extractTopicsFromBio(character.bio);
      }
    } else {
      logger.warn(
        "Character not available in runtime, using default topics for discovery",
      );
    }

    return {
      topics,
      minFollowerCount: parseInt(
        (getSetting(this.runtime, "TWITTER_MIN_FOLLOWER_COUNT") as string) ||
          process.env.TWITTER_MIN_FOLLOWER_COUNT ||
          "100",
      ),
      maxFollowsPerCycle: parseInt(
        (getSetting(this.runtime, "TWITTER_MAX_FOLLOWS_PER_CYCLE") as string) ||
          process.env.TWITTER_MAX_FOLLOWS_PER_CYCLE ||
          "5",
      ),
      maxEngagementsPerCycle: parseInt(
        (getSetting(
          this.runtime,
          "TWITTER_MAX_ENGAGEMENTS_PER_RUN",
        ) as string) ||
          process.env.TWITTER_MAX_ENGAGEMENTS_PER_RUN ||
          "5",  // Reduced from 10 to 5
      ),
      likeThreshold: 0.5,    // Increased from 0.3 (be more selective)
      replyThreshold: 0.7,   // Increased from 0.5 (be more selective)
      quoteThreshold: 0.85,  // Increased from 0.7 (be more selective)
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
        (word) =>
          ![
            "about",
            "helping",
            "working",
            "people",
            "making",
            "building",
          ].includes(word),
      );
    return [...new Set(words)].slice(0, 5); // Limit to 5 topics
  }

  async start() {
    logger.info("Starting Twitter Discovery Client...");
    this.isRunning = true;

    const discoveryLoop = async () => {
      if (!this.isRunning) {
        logger.info("Discovery client stopped, exiting loop");
        return;
      }

      try {
        await this.runDiscoveryCycle();
      } catch (error) {
        logger.error("Discovery cycle error:", error);
      }

      // Run discovery every 20-40 minutes (with variance)
      const discoveryIntervalMinutes = getRandomInterval(this.runtime, 'discovery');
      const nextInterval = discoveryIntervalMinutes * 60 * 1000;

      logger.log(
        `Next discovery cycle in ${discoveryIntervalMinutes.toFixed(1)} minutes`,
      );

      // Schedule next discovery
      setTimeout(discoveryLoop, nextInterval);
    };

    // Start after a short delay
    setTimeout(discoveryLoop, 5000);
  }

  async stop() {
    logger.info("Stopping Twitter Discovery Client...");
    this.isRunning = false;
  }

  private async runDiscoveryCycle() {
    logger.info("Starting Twitter discovery cycle...");

    const discoveries = await this.discoverContent();
    const { tweets, accounts } = discoveries;

    logger.info(
      `Discovered ${tweets.length} tweets and ${accounts.length} accounts`,
    );

    // Process discovered accounts (follow high-quality ones)
    const followedCount = await this.processAccounts(accounts);

    // Process discovered tweets (engage with relevant ones)
    const engagementCount = await this.processTweets(tweets);

    logger.info(
      `Discovery cycle complete: ${followedCount} follows, ${engagementCount} engagements`,
    );
  }

  private async discoverContent(): Promise<{
    tweets: ScoredTweet[];
    accounts: ScoredAccount[];
  }> {
    const allTweets: ScoredTweet[] = [];
    const allAccounts = new Map<string, ScoredAccount>();

    // Note: Twitter API v2 doesn't support trends, so we skip trend-based discovery

    // 1. Discover from topic searches (primary discovery method)
    try {
      const topicContent = await this.discoverFromTopics();
      allTweets.push(...topicContent.tweets);
      topicContent.accounts.forEach((acc) => allAccounts.set(acc.user.id, acc));
    } catch (error) {
      logger.error("Failed to discover from topics:", error);
    }

    // 2. Discover from conversation threads
    try {
      const threadContent = await this.discoverFromThreads();
      allTweets.push(...threadContent.tweets);
      threadContent.accounts.forEach((acc) =>
        allAccounts.set(acc.user.id, acc),
      );
    } catch (error) {
      logger.error("Failed to discover from threads:", error);
    }

    // 3. Discover from popular accounts in our topics
    try {
      const popularContent = await this.discoverFromPopularAccounts();
      allTweets.push(...popularContent.tweets);
      popularContent.accounts.forEach((acc) =>
        allAccounts.set(acc.user.id, acc),
      );
    } catch (error) {
      logger.error("Failed to discover from popular accounts:", error);
    }

    // Sort by relevance score
    const sortedTweets = allTweets
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 50); // Top 50 tweets

    const sortedAccounts = Array.from(allAccounts.values())
      .sort(
        (a, b) =>
          b.qualityScore * b.relevanceScore - a.qualityScore * a.relevanceScore,
      )
      .slice(0, 20); // Top 20 accounts

    return { tweets: sortedTweets, accounts: sortedAccounts };
  }

  private async discoverFromTopics(): Promise<{
    tweets: ScoredTweet[];
    accounts: ScoredAccount[];
  }> {
    logger.debug("Discovering from character topics...");

    const tweets: ScoredTweet[] = [];
    const accounts = new Map<string, ScoredAccount>();

    // Search for each topic with different query strategies
    for (const topic of this.config.topics.slice(0, 5)) {
      try {
        // Sanitize topic for search query
        const searchTopic = this.sanitizeTopic(topic);

        // Strategy 1: Popular tweets in topic
        // Note: min_faves is not supported in Twitter API v2, we'll filter after retrieval
        const popularQuery = `${searchTopic} -is:retweet -is:reply lang:en`;

        logger.debug(`Searching popular tweets for topic: ${topic}`);
        const popularResults = await this.twitterClient.fetchSearchTweets(
          popularQuery,
          20,
          SearchMode.Top,
        );

        for (const tweet of popularResults.tweets) {
          // Filter by engagement after retrieval
          if ((tweet.likes || 0) < 10) continue;

          const scored = this.scoreTweet(tweet, "topic");
          tweets.push(scored);

          // Extract account info from popular tweet authors
          const authorUsername = tweet.username;
          const authorName = tweet.name || tweet.username;

          // Estimate follower count based on tweet engagement
          // Popular tweets often come from accounts with decent followings
          const estimatedFollowers = Math.max(
            1000, // minimum estimate
            (tweet.likes || 0) * 100 // rough estimate: 100 followers per like
          );

          const account = this.scoreAccount({
            id: tweet.userId,
            username: authorUsername,
            name: authorName,
            followersCount: estimatedFollowers,
          });

          if (account.qualityScore > 0.3) { // Lower threshold to discover more accounts
            accounts.set(tweet.userId, account);
          }
        }

        // Strategy 2: Latest tweets with good engagement (not just verified)
        const engagedQuery = `${searchTopic} -is:retweet lang:en`;

        logger.debug(`Searching engaged tweets for topic: ${topic}`);
        const engagedResults = await this.twitterClient.fetchSearchTweets(
          engagedQuery,
          15,
          SearchMode.Latest,
        );

        for (const tweet of engagedResults.tweets) {
          // Only include tweets with some engagement
          if ((tweet.likes || 0) < 5) continue;
          
          const scored = this.scoreTweet(tweet, "topic");
          tweets.push(scored);

          // Extract account info from tweet author
          const authorUsername = tweet.username;
          const authorName = tweet.name || tweet.username;

          // Estimate follower count based on engagement
          const estimatedFollowers = Math.max(
            500, // minimum for engaged tweets
            (tweet.likes || 0) * 50
          );

          const account = this.scoreAccount({
            id: tweet.userId,
            username: authorUsername,
            name: authorName,
            followersCount: estimatedFollowers,
          });

          if (account.qualityScore > 0.2) { // Even lower threshold for engaged content
            accounts.set(tweet.userId, account);
          }
        }
      } catch (error) {
        logger.error(`Failed to search topic ${topic}:`, error);
      }
    }

    return { tweets, accounts: Array.from(accounts.values()) };
  }

  private async discoverFromThreads(): Promise<{
    tweets: ScoredTweet[];
    accounts: ScoredAccount[];
  }> {
    logger.debug("Discovering from conversation threads...");

    const tweets: ScoredTweet[] = [];
    const accounts = new Map<string, ScoredAccount>();

    // Search for viral conversations in our topics
    // Note: Twitter API v2 doesn't support min_replies or min_faves operators
    // We'll search for popular conversations and filter by engagement in scoring
    const topicQuery = this.config.topics
      .slice(0, 3)
      .map((t) => this.sanitizeTopic(t))
      .join(" OR ");

    try {
      // Search for conversations (tweets with engagement)
      const viralQuery = `(${topicQuery}) -is:retweet has:mentions`;

      logger.debug(`Searching viral threads with query: ${viralQuery}`);
      const searchResults = await this.twitterClient.fetchSearchTweets(
        viralQuery,
        15,
        SearchMode.Top,
      );

      for (const tweet of searchResults.tweets) {
        // Filter for tweets with good engagement (proxy for viral threads)
        const engagementScore = (tweet.likes || 0) + (tweet.retweets || 0) * 2;
        if (engagementScore < 10) continue; // Lowered from 50 - more inclusive

        const scored = this.scoreTweet(tweet, "thread");
        tweets.push(scored);

        // Viral thread authors are likely high-quality accounts
        const account = this.scoreAccount({
          id: tweet.userId,
          username: tweet.username,
          name: tweet.name || tweet.username,
          followersCount: 1000, // Reasonable estimate for engaged users
        });

        if (account.qualityScore > 0.5) {
          // Lowered from 0.6
          accounts.set(tweet.userId, account);
        }
      }
    } catch (error) {
      logger.error("Failed to discover threads:", error);
    }

    return { tweets, accounts: Array.from(accounts.values()) };
  }

  private async discoverFromPopularAccounts(): Promise<{
    tweets: ScoredTweet[];
    accounts: ScoredAccount[];
  }> {
    logger.debug("Discovering from popular accounts in topics...");

    const tweets: ScoredTweet[] = [];
    const accounts = new Map<string, ScoredAccount>();

    // Search for users who frequently tweet about our topics
    for (const topic of this.config.topics.slice(0, 3)) {
      try {
        // Sanitize topic for search query
        const searchTopic = this.sanitizeTopic(topic);

        // Find tweets from accounts with high engagement
        // Note: Twitter API v2 doesn't support min_faves or min_retweets in search
        // We'll search for general high-quality content
        const influencerQuery = `${searchTopic} -is:retweet lang:en`;

        logger.debug(`Searching for influencers in topic: ${topic}`);
        const results = await this.twitterClient.fetchSearchTweets(
          influencerQuery,
          10,
          SearchMode.Top,
        );

        for (const tweet of results.tweets) {
          // Filter by engagement metrics after retrieval
          const engagement = (tweet.likes || 0) + (tweet.retweets || 0) * 2;
          if (engagement < 5) continue; // Lowered from 20 - more inclusive

          const scored = this.scoreTweet(tweet, "topic");
          tweets.push(scored);

          // High engagement suggests a quality account
          const estimatedFollowers = Math.max(
            (tweet.likes || 0) * 100,
            (tweet.retweets || 0) * 200,
            10000,
          );

          const account = this.scoreAccount({
            id: tweet.userId,
            username: tweet.username,
            name: tweet.name || tweet.username,
            followersCount: estimatedFollowers,
          });

          if (account.qualityScore > 0.7) {
            accounts.set(tweet.userId, account);
          }
        }
      } catch (error) {
        logger.error(
          `Failed to discover popular accounts for ${topic}:`,
          error,
        );
      }
    }

    return { tweets, accounts: Array.from(accounts.values()) };
  }

  // Remove the discoverFromTrends method since API v2 doesn't support it
  // Remove the isTrendRelevant method since we're not using trends

  private scoreTweet(
    tweet: Tweet,
    source: string,
  ): ScoredTweet {
    // Skip retweets - we want original content
    if (tweet.isRetweet) {
      return {
        tweet,
        relevanceScore: 0,
        engagementType: "skip",
      };
    }

    let relevanceScore = 0;

    // Base score by source
    const sourceScores = {
      topic: 0.4,
      thread: 0.35,
    };
    relevanceScore += sourceScores[source];

    // Score by engagement metrics - much more realistic thresholds
    const engagementScore = Math.min(
      (tweet.likes || 0) / 100 + // 100 likes = 0.1 points (was 1000)
        (tweet.retweets || 0) / 50 + // 50 retweets = 0.1 points (was 500)
        (tweet.replies || 0) / 20, // 20 replies = 0.1 points (was 100)
      0.3,
    );
    relevanceScore += engagementScore;

    // Score by content relevance to topics
    const textLower = tweet.text.toLowerCase();
    const topicMatches = this.config.topics.filter((topic) =>
      textLower.includes(topic.toLowerCase()),
    ).length;
    relevanceScore += Math.min(topicMatches * 0.15, 0.3); // Increased from 0.1

    // Bonus for verified accounts (if available in tweet data)
    // Note: isBlueVerified might not be available in all tweet responses

    // Normalize score
    relevanceScore = Math.min(relevanceScore, 1);

    // Determine engagement type based on score
    let engagementType: ScoredTweet["engagementType"] = "skip";
    if (relevanceScore >= this.config.quoteThreshold) {
      engagementType = "quote";
    } else if (relevanceScore >= this.config.replyThreshold) {
      engagementType = "reply";
    } else if (relevanceScore >= this.config.likeThreshold) {
      engagementType = "like";
    }

    return {
      tweet,
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
      userText.includes(topic.toLowerCase()),
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
              `relevance: ${scoredAccount.relevanceScore.toFixed(2)})`,
          );
        } else {
          // Follow the account
          await this.twitterClient.followUser(scoredAccount.user.id);

          logger.info(
            `Followed @${scoredAccount.user.username} ` +
              `(quality: ${scoredAccount.qualityScore.toFixed(2)}, ` +
              `relevance: ${scoredAccount.relevanceScore.toFixed(2)})`,
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
          error,
        );
      }
    }

    return followedCount;
  }

  private async processTweets(tweets: ScoredTweet[]): Promise<number> {
    let engagementCount = 0;

    for (const scoredTweet of tweets) {
      if (engagementCount >= this.config.maxEngagementsPerCycle) break;
      if (scoredTweet.engagementType === "skip") continue;

      try {
        // Check if already engaged
        const tweetMemoryId = createUniqueUuid(
          this.runtime,
          scoredTweet.tweet.id,
        );
        const existingMemory = await this.runtime.getMemoryById(tweetMemoryId);
        if (existingMemory) {
          logger.debug(
            `Already engaged with tweet ${scoredTweet.tweet.id}, skipping`,
          );
          continue;
        }

        // Perform engagement
        switch (scoredTweet.engagementType) {
          case "like":
            if (this.isDryRun) {
              logger.info(
                `[DRY RUN] Would like tweet: ${scoredTweet.tweet.id} (score: ${scoredTweet.relevanceScore.toFixed(2)})`,
              );
            } else {
              await this.twitterClient.likeTweet(scoredTweet.tweet.id);
              logger.info(
                `Liked tweet: ${scoredTweet.tweet.id} (score: ${scoredTweet.relevanceScore.toFixed(2)})`,
              );
            }
            break;

          case "reply":
            const replyText = await this.generateReply(scoredTweet.tweet);
            if (this.isDryRun) {
              logger.info(
                `[DRY RUN] Would reply to tweet ${scoredTweet.tweet.id} with: "${replyText}"`,
              );
            } else {
              await this.twitterClient.sendTweet(
                replyText,
                scoredTweet.tweet.id,
              );
              logger.info(`Replied to tweet: ${scoredTweet.tweet.id}`);
            }
            break;

          case "quote":
            const quoteText = await this.generateQuote(scoredTweet.tweet);
            if (this.isDryRun) {
              logger.info(
                `[DRY RUN] Would quote tweet ${scoredTweet.tweet.id} with: "${quoteText}"`,
              );
            } else {
              await this.twitterClient.sendQuoteTweet(
                quoteText,
                scoredTweet.tweet.id,
              );
              logger.info(`Quoted tweet: ${scoredTweet.tweet.id}`);
            }
            break;
        }

        // Save engagement to memory (even in dry run for tracking)
        await this.saveEngagementMemory(
          scoredTweet.tweet,
          scoredTweet.engagementType,
        );

        engagementCount++;

        // Add delay to avoid rate limits
        await this.delay(3000 + Math.random() * 5000);
      } catch (error: any) {
        // Check if it's a 403 error
        if (error?.message?.includes("403")) {
          logger.warn(
            `Permission denied (403) for tweet ${scoredTweet.tweet.id}. ` +
            `This might be a protected account or restricted tweet. Skipping.`
          );
          // Still save to memory to avoid retrying
          await this.saveEngagementMemory(
            scoredTweet.tweet,
            "skip"
          );
        } else if (error?.message?.includes("429")) {
          logger.warn(
            `Rate limit (429) hit while engaging with tweet ${scoredTweet.tweet.id}. ` +
            `Pausing engagement cycle.`
          );
          // Break out of the loop on rate limit
          break;
        } else {
          logger.error(
            `Failed to engage with tweet ${scoredTweet.tweet.id}:`,
            error
          );
        }
      }
    }

    return engagementCount;
  }

  private async checkIfFollowing(userId: string): Promise<boolean> {
    // Check our memory to see if we've followed them
    const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: `followed twitter user ${userId}`,
    });

    const followMemories = await this.runtime.searchMemories({
      tableName: "messages",
      embedding,
      match_threshold: 0.8,
      count: 1,
    });
    return followMemories.length > 0;
  }

  private async generateReply(tweet: Tweet): Promise<string> {
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

    const prompt = `You are ${characterName}. Generate a thoughtful reply to this tweet:

Tweet by @${tweet.username}: "${tweet.text}"

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
      max_tokens: 100,
      temperature: 0.8,
    });

    return response.trim();
  }

  private async generateQuote(tweet: Tweet): Promise<string> {
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

    const prompt = `You are ${characterName}. Add your perspective to this tweet with a quote tweet:

Original tweet by @${tweet.username}: "${tweet.text}"

Your interests: ${this.config.topics.join(", ")}
Character bio: ${characterBio}

Create a quote tweet that:
- Adds unique insight or perspective
- Is under 280 characters
- Respectfully builds on the original idea
- Showcases your expertise
- Encourages further discussion

Quote tweet:`;

    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      max_tokens: 100,
      temperature: 0.8,
    });

    return response.trim();
  }

  private async saveEngagementMemory(tweet: Tweet, engagementType: string) {
    try {
      // Ensure context exists before saving memory
      const context = await ensureTwitterContext(this.runtime, {
        userId: tweet.userId,
        username: tweet.username,
        conversationId: tweet.conversationId || tweet.id,
      });

      const memory: Memory = {
        id: createUniqueUuid(this.runtime, `${tweet.id}-${engagementType}`),
        entityId: context.entityId,
        content: {
          text: `${engagementType} tweet from @${tweet.username}: ${tweet.text}`,
          metadata: {
            tweetId: tweet.id,
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
      logger.debug(`[Discovery] Saved ${engagementType} memory for tweet ${tweet.id}`);
    } catch (error) {
      logger.error(`[Discovery] Failed to save engagement memory:`, error);
      // Don't throw - just log the error
    }
  }

  private async saveFollowMemory(user: ScoredAccount["user"]) {
    try {
      // Create a simple context for follows
      const context = await ensureTwitterContext(this.runtime, {
        userId: user.id,
        username: user.username,
        name: user.name,
        conversationId: `twitter-follows`,
      });

      const memory: Memory = {
        id: createUniqueUuid(this.runtime, `follow-${user.id}`),
        entityId: context.entityId,
        content: {
          text: `followed twitter user ${user.id} @${user.username}`,
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
      logger.error(`[Discovery] Failed to save follow memory:`, error);
      // Don't throw - just log the error
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
