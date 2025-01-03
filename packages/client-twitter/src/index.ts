import { TwitterPostClient } from "./post.ts";
import { TwitterSearchClient } from "./search.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { TwitterViralClient } from "./viral.ts";
import { IAgentRuntime, Client, elizaLogger } from "@ai16z/eliza";
import { validateTwitterConfig } from "./environment.ts";
import { ClientBase } from "./base.ts";
import { TwitterSpaceClient } from "./spaces";

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
    viral: TwitterViralClient;
    space?: TwitterSpaceClient;

    constructor(runtime: IAgentRuntime, enableSearch:boolean) {
        this.client = new ClientBase(runtime);
        this.post = new TwitterPostClient(this.client, runtime);

        if (enableSearch) {
          // this searches topics from character file
          elizaLogger.warn('Twitter/X client running in a mode that:')
          elizaLogger.warn('1. violates consent of random users')
          elizaLogger.warn('2. burns your rate limit')
          elizaLogger.warn('3. can get your account banned')
          elizaLogger.warn('use at your own risk')
          this.search = new TwitterSearchClient(this.client, runtime); // don't start the search client by default
        }
        this.interaction = new TwitterInteractionClient(this.client, runtime);
        this.viral = new TwitterViralClient(this.client, runtime);
        if (runtime.getSetting("TWITTER_SPACES_ENABLE")) {
            this.space = new TwitterSpaceClient(this.client, runtime);
        }
    }
}

export const TwitterClientInterface: Client = {

    async start(runtime: IAgentRuntime) {
        await validateTwitterConfig(runtime);

        elizaLogger.log("Twitter client started");

        // enableSearch is just set previous to this call
        // so enableSearch can change over time
        // and changing it won't stop the SearchClient in the existing instance
        const manager = new TwitterManager(runtime, this.enableSearch);

        await manager.client.init();

        await manager.post.start();

        // await manager.interaction.start();

        // await manager.search.start(); // don't run the search by default

        await manager.viral.start();

        // if (manager.space) {
        //     manager.space.startPeriodicSpaceCheck();
        // }

        return manager;
    },
    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client does not support stopping yet");
    },
};

export default TwitterClientInterface;
