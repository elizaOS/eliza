import {elizaLogger, type IAgentRuntime, type Memory, type Provider, type State} from "@elizaos/core";
import {TwitterScraper} from "../util/twitterScraper.ts";

const tweetProvider: Provider = {
    // eslint-disable-next-line
    get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
        const scraperWithPrimus = new TwitterScraper();
        try {
            elizaLogger.info("Attempting Twitter login");
            await scraperWithPrimus.login();
            elizaLogger.info("Twitter login successful");
        }catch (error){
            elizaLogger.error("Twitter login failed:", error);
            return false;
        }

        if (!(await scraperWithPrimus.getScraper().isLoggedIn())) {
            elizaLogger.error("Failed to login to Twitter");
            return false;
        }
        const userName = process.env.TWITTER_USERNAME_WANT_TO_GET_TWEET;
        if(!userName){
            elizaLogger.error("TWITTER_USERNAME_WANT_TO_GET_TWEET is not set");
            return false;
        }
        elizaLogger.debug(`Fetching tweets for user: ${userName}`);
        const userId = await scraperWithPrimus.getUserIdByScreenName(userName);
        elizaLogger.debug(`Fetching tweets for user: ${userName}`);
        try {
            const result = await scraperWithPrimus.getUserLatestTweet(userId);
            elizaLogger.debug("Tweet retrieved successfully");
            return result;
        } catch (error) {
            elizaLogger.error("Failed to fetch tweet:", error);
            return false;
        }
    },
};

export { tweetProvider };
