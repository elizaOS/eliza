import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { TwitterService } from "./services/twitter.service.js";
import { postTweetAction } from "./actions/postTweet.js";
import { getSetting } from "./utils/settings";

export const TwitterPlugin: Plugin = {
  name: "twitter",
  description:
    "Twitter client with posting, interactions, and timeline actions",
  actions: [postTweetAction],
  services: [TwitterService],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Only do validation in init, don't start services
    logger.log("🔧 Initializing Twitter plugin...");

    const mode = (getSetting(runtime, "TWITTER_AUTH_MODE") || "env").toLowerCase();

    if (mode === "env") {
      const apiKey = getSetting(runtime, "TWITTER_API_KEY");
      const apiSecretKey = getSetting(runtime, "TWITTER_API_SECRET_KEY");
      const accessToken = getSetting(runtime, "TWITTER_ACCESS_TOKEN");
      const accessTokenSecret = getSetting(runtime, "TWITTER_ACCESS_TOKEN_SECRET");

      if (!apiKey || !apiSecretKey || !accessToken || !accessTokenSecret) {
        const missing = [];
        if (!apiKey) missing.push("TWITTER_API_KEY");
        if (!apiSecretKey) missing.push("TWITTER_API_SECRET_KEY");
        if (!accessToken) missing.push("TWITTER_ACCESS_TOKEN");
        if (!accessTokenSecret) missing.push("TWITTER_ACCESS_TOKEN_SECRET");

        logger.warn(
          `Twitter env auth not configured - Twitter functionality will be limited. Missing: ${missing.join(", ")}`,
        );
      } else {
        logger.log("✅ Twitter env credentials found");
      }
    } else if (mode === "oauth") {
      const clientId = getSetting(runtime, "TWITTER_CLIENT_ID");
      const redirectUri = getSetting(runtime, "TWITTER_REDIRECT_URI");
      if (!clientId || !redirectUri) {
        const missing = [];
        if (!clientId) missing.push("TWITTER_CLIENT_ID");
        if (!redirectUri) missing.push("TWITTER_REDIRECT_URI");
        logger.warn(
          `Twitter OAuth not configured - Twitter functionality will be limited. Missing: ${missing.join(", ")}`,
        );
      } else {
        logger.log("✅ Twitter OAuth configuration found");
      }
    } else if (mode === "broker") {
      const brokerUrl = getSetting(runtime, "TWITTER_BROKER_URL");
      if (!brokerUrl) {
        logger.warn(
          "TWITTER_AUTH_MODE=broker requires TWITTER_BROKER_URL (broker auth is not implemented yet).",
        );
      } else {
        logger.log("ℹ️ Twitter broker mode configured (stub; not functional yet)");
      }
    } else {
      logger.warn(
        `Invalid TWITTER_AUTH_MODE=${mode}. Expected env|oauth|broker.`,
      );
    }
  },
};

export default TwitterPlugin;
