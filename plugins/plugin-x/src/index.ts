import {
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
  type Plugin,
} from "@elizaos/core";
import {
  createXConnectorAccountProvider,
  materializeEnvAccountIfMissing,
} from "./connector-account-provider.js";
import { XService } from "./services/x.service.js";
import { getSetting } from "./utils/settings";

export const XPlugin: Plugin = {
  name: "x",
  description:
    "X (formerly Twitter) connector with posting, interactions, and timeline actions",
  actions: [],
  providers: [],
  services: [XService],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    logger.log("🔧 Initializing X plugin...");

    const mode = (
      getSetting(runtime, "TWITTER_AUTH_MODE") || "env"
    ).toLowerCase();

    if (mode === "env") {
      const apiKey = getSetting(runtime, "TWITTER_API_KEY");
      const apiSecretKey = getSetting(runtime, "TWITTER_API_SECRET_KEY");
      const accessToken = getSetting(runtime, "TWITTER_ACCESS_TOKEN");
      const accessTokenSecret = getSetting(
        runtime,
        "TWITTER_ACCESS_TOKEN_SECRET",
      );

      if (!apiKey || !apiSecretKey || !accessToken || !accessTokenSecret) {
        const missing = [];
        if (!apiKey) missing.push("TWITTER_API_KEY");
        if (!apiSecretKey) missing.push("TWITTER_API_SECRET_KEY");
        if (!accessToken) missing.push("TWITTER_ACCESS_TOKEN");
        if (!accessTokenSecret) missing.push("TWITTER_ACCESS_TOKEN_SECRET");

        logger.warn(
          `X env auth not configured - X functionality will be limited. Missing: ${missing.join(", ")}`,
        );
      } else {
        logger.log("✅ X env credentials found");
      }
    } else if (mode === "oauth") {
      const clientId = getSetting(runtime, "TWITTER_CLIENT_ID");
      const redirectUri = getSetting(runtime, "TWITTER_REDIRECT_URI");
      if (!clientId || !redirectUri) {
        const missing = [];
        if (!clientId) missing.push("TWITTER_CLIENT_ID");
        if (!redirectUri) missing.push("TWITTER_REDIRECT_URI");
        logger.warn(
          `X OAuth not configured - X functionality will be limited. Missing: ${missing.join(", ")}`,
        );
      } else {
        logger.log("✅ X OAuth configuration found");
      }
    } else {
      logger.warn(`Invalid TWITTER_AUTH_MODE=${mode}. Expected env|oauth.`);
    }

    // Register with the ConnectorAccountManager so the generic HTTP CRUD/OAuth
    // surface can list, create, patch, delete, and start OAuth on X accounts.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createXConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:x",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register X provider with ConnectorAccountManager",
      );
    }

    // In env mode, materialize a synthetic `default` account so the rest of
    // the runtime can address it through the connector account interface.
    if (mode === "env") {
      await materializeEnvAccountIfMissing(runtime);
    }
  },
};

export default XPlugin;
