/**
 * Broker auth provider — routes X API calls through a managed OAuth proxy (Eliza Cloud).
 *
 * In broker mode, the agent does not directly authenticate with X. Instead, all API
 * requests are proxied through `TWITTER_BROKER_URL` (default: https://api.eliza.app/api/v1/twitter),
 * which handles OAuth and credential management on behalf of the agent.
 *
 * The broker token (`TWITTER_BROKER_TOKEN`) identifies the agent to the broker;
 * it defaults to `ELIZAOS_CLOUD_API_KEY` if unset.
 *
 * The broker validates the agent and forwards API requests to X with the appropriate
 * user credentials, returning responses as if the agent had made the call directly.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { TwitterClientState } from "../../types";
import { getSetting } from "../../utils/settings";
import type { TwitterAuthProvider } from "./types";

export class BrokerAuthProvider implements TwitterAuthProvider {
  readonly mode = "broker" as const;

  private brokerUrl: string;
  private brokerToken: string | null;
  private runtime: IAgentRuntime;
  private state?: TwitterClientState;

  constructor(runtime: IAgentRuntime, state?: TwitterClientState) {
    this.runtime = runtime;
    this.state = state;

    this.brokerUrl =
      getSetting(runtime, "TWITTER_BROKER_URL") ??
      "https://api.eliza.app/api/v1/twitter";

    // Try TWITTER_BROKER_TOKEN first, fall back to ELIZAOS_CLOUD_API_KEY
    this.brokerToken =
      getSetting(runtime, "TWITTER_BROKER_TOKEN") ??
      getSetting(runtime, "ELIZAOS_CLOUD_API_KEY") ??
      null;

    if (!this.brokerToken) {
      logger.warn(
        "BrokerAuthProvider: no TWITTER_BROKER_TOKEN or ELIZAOS_CLOUD_API_KEY set. Broker requests will not be authenticated.",
      );
    }
  }

  /**
   * Returns a bearer token that identifies this agent to the broker.
   * The broker will use its own managed credentials to fulfill API requests.
   */
  async getAccessToken(): Promise<string> {
    if (!this.brokerToken) {
      throw new Error(
        "Broker authentication requires TWITTER_BROKER_TOKEN or ELIZAOS_CLOUD_API_KEY",
      );
    }
    return this.brokerToken;
  }

  /**
   * Returns the broker base URL for use as an API endpoint override.
   * Callers should redirect twitter-api-v2 requests to this broker instead of the public API.
   */
  getBrokerUrl(): string {
    return this.brokerUrl;
  }
}
