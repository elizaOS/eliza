/**
 * Plugin entry-point for the X (Twitter) connector: exports `XPlugin`, which
 * registers the `XService` and `XWorkflowCredentialProvider` services and the
 * `TWITTER_IDENTITY` provider. `init` validates auth-mode credentials and
 * registers the X account provider with the runtime's ConnectorAccountManager;
 * env account materialization and the autonomous loops run later in
 * `XService.start`. No actions or evaluators are registered — all agent-facing
 * behavior flows through the message and post connectors.
 */
import {
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
  type Plugin,
} from "@elizaos/core";
import { createXConnectorAccountProvider } from "./connector-account-provider.js";

export { XDmAdapter } from "./lifeops-message-adapter.js";

import { xIdentityProvider } from "./identity-provider.js";
import { XService } from "./services/x.service.js";
import { getSetting } from "./utils/settings";
import { XWorkflowCredentialProvider } from "./workflow-credential-provider.js";

export { xIdentityProvider } from "./identity-provider.js";

export const XPlugin: Plugin = {
  name: "x",
  description:
    "X (formerly Twitter) connector with posting, interactions, and timeline actions",
  connectorSources: [
    {
      source: "x",
      aliases: ["x", "x_dm"],
      sourceKind: "passive",
      isPassive: true,
    },
  ],
  actions: [],
  providers: [xIdentityProvider],
  services: [XService, XWorkflowCredentialProvider],
  // Self-declared auto-enable: activate when the "x" connector (or the legacy
  // "twitter" alias) is configured under config.connectors. The hardcoded
  // CONNECTOR_PLUGINS map in plugin-auto-enable-engine.ts still serves as a
  // fallback.
  autoEnable: {
    connectorKeys: ["x", "twitter"],
  },
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

    // Env account materialization runs in XService.start (after plugin-sql migrations).
  },
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<XService>(XService.serviceType);
    await svc?.stop();
  },
};

export default XPlugin;
