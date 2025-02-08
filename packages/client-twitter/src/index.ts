import { type Client, elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig, type TwitterConfig } from "./environment.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterSearchClient } from "./search.ts";
import { TwitterSpaceClient } from "./spaces.ts";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - search: searching tweets / replying logic
 * - interaction: handling mentions, replies
 * - space: launching and managing Twitter Spaces (optional)
 */
class TwitterManager {
    client: ClientBase;
    post: TwitterPostClient;
    search: TwitterSearchClient;
    interaction: TwitterInteractionClient;
    space?: TwitterSpaceClient;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        // Pass twitterConfig to the base client
        this.client = new ClientBase(runtime, twitterConfig);

        // Posting logic
        this.post = new TwitterPostClient(this.client, runtime);

        // Optional search logic (enabled if TWITTER_SEARCH_ENABLE is true)
        if (twitterConfig.TWITTER_SEARCH_ENABLE) {
            elizaLogger.warn("Twitter/X client running in a mode that:");
            elizaLogger.warn("1. violates consent of random users");
            elizaLogger.warn("2. burns your rate limit");
            elizaLogger.warn("3. can get your account banned");
            elizaLogger.warn("use at your own risk");
            this.search = new TwitterSearchClient(this.client, runtime);
        }

        // Mentions and interactions
        this.interaction = new TwitterInteractionClient(this.client, runtime);

        // Optional Spaces logic (enabled if TWITTER_SPACES_ENABLE is true)
        if (twitterConfig.TWITTER_SPACES_ENABLE) {
            this.space = new TwitterSpaceClient(this.client, runtime);
        }
    }

    stop() {
        elizaLogger.log('client-twitter stopping, agentId:', this.client.runtime.agentId);
        this.client.stop();
        this.post.stop();
        if(this.search) this.search.stop();
        this.interaction.stop();
        if(this.space) this.space.stop();
        elizaLogger.log('client-twitter stopped, agentId:', this.client.runtime.agentId);
    }
}

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        const twitterConfig: TwitterConfig =
            await validateTwitterConfig(runtime);

        elizaLogger.log("Twitter client started");

        this.manager = new TwitterManager(runtime, twitterConfig);

        // Initialize login/session
        await this.manager.client.init();

        // Start the posting loop
        await this.manager.post.start();

        // Start the search logic if it exists
        if (this.manager.search) {
            await this.manager.search.start();
        }

        // Start interactions (mentions, replies)
        await this.manager.interaction.start();

        // If Spaces are enabled, start the periodic check
        if (this.manager.space) {
            this.manager.space.startPeriodicSpaceCheck();
        }

        return this.manager;
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client stop..., agentId:", _runtime.agentId);
        this.manager.stop();
    },
};

export default TwitterClientInterface;
