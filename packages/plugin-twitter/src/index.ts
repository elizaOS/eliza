import { type Client, logger, type IAgentRuntime, type Plugin } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig, type TwitterConfig } from "./environment.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterSpaceClient } from "./spaces.ts";
import post from "./actions/post.ts";
import reply from "./actions/reply.ts";

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
    interaction: TwitterInteractionClient;
    space?: TwitterSpaceClient;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        // Pass twitterConfig to the base client
        this.client = new ClientBase(runtime, twitterConfig);

        // Posting logic
        this.post = new TwitterPostClient(this.client, runtime);

        // Mentions and interactions
        this.interaction = new TwitterInteractionClient(this.client, runtime);

        // Optional Spaces logic (enabled if TWITTER_SPACES_ENABLE is true)
        if (twitterConfig.TWITTER_SPACES_ENABLE) {
            this.space = new TwitterSpaceClient(this.client, runtime);
        }
    }

    async stop() {
        logger.warn("Twitter client does not support stopping yet");
    }
}

export const TwitterClientInterface: Client = {
    name: 'twitter',
    start: async (runtime: IAgentRuntime) => {
        const twitterConfig: TwitterConfig =
            await validateTwitterConfig(runtime);

        logger.log("Twitter client started");

        const manager = new TwitterManager(runtime, twitterConfig);

        // Initialize login/session
        await manager.client.init();

        // Start the posting loop
        await manager.post.start();

        // Start interactions (mentions, replies)
        await manager.interaction.start();

        // If Spaces are enabled, start the periodic check
        if (manager.space) {
            manager.space.startPeriodicSpaceCheck();
        }

        return manager;
    },
};

const twitterPlugin: Plugin = {
    name: "twitter",
    description: "Twitter client",
    clients: [TwitterClientInterface],
    actions: [post, reply]
};
export default twitterPlugin;
