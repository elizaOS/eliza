import { Client, elizaLogger, IAgentRuntime } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig } from "./environment.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterSearchClient } from "./search.ts";

/**
 * Class representing a Twitter manager for interacting with Twitter API.
 * @class
 */
class TwitterManager {
    client: ClientBase;
    post: TwitterPostClient;
    search: TwitterSearchClient;
    interaction: TwitterInteractionClient;
/**
 * Constructor for creating a new Twitter client with specified runtime and search functionality.
 *
 * @param {IAgentRuntime} runtime - The runtime environment for the client.
 * @param {boolean} enableSearch - Flag to enable search functionality.
 */
    constructor(runtime: IAgentRuntime, enableSearch: boolean) {
        this.client = new ClientBase(runtime);
        this.post = new TwitterPostClient(this.client, runtime);

        if (enableSearch) {
            // this searches topics from character file
            elizaLogger.warn("Twitter/X client running in a mode that:");
            elizaLogger.warn("1. violates consent of random users");
            elizaLogger.warn("2. burns your rate limit");
            elizaLogger.warn("3. can get your account banned");
            elizaLogger.warn("use at your own risk");
            this.search = new TwitterSearchClient(this.client, runtime);
        }

        this.interaction = new TwitterInteractionClient(this.client, runtime);
    }
}

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        await validateTwitterConfig(runtime);

        elizaLogger.log("Twitter client started");

        const manager = new TwitterManager(runtime, this.enableSearch);

        await manager.client.init();

        await manager.post.start();

        await manager.interaction.start();

        await manager.search?.start();

        return manager;
    },
    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client does not support stopping yet");
    },
};

export default TwitterClientInterface;
