import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import type { XAuthProvider } from "./types";

/**
 * Broker-ready scaffolding (stub only).
 *
 * Future contract idea (v1):
 * - GET {X_BROKER_URL}/v1/x/access-token
 *   -> { access_token: string, expires_at: number }
 *
 * This plugin intentionally ships NO secrets. The broker would handle client secrets
 * and user sessions, returning short-lived access tokens to the agent.
 */
export class BrokerAuthProvider implements XAuthProvider {
  readonly mode = "broker" as const;

  constructor(private readonly runtime: IAgentRuntime) {}

  async getAccessToken(): Promise<string> {
    const url = getSetting(this.runtime, "X_BROKER_URL");
    if (!url) {
      throw new Error("X_AUTH_MODE=broker requires X_BROKER_URL (broker not implemented yet).");
    }
    throw new Error(
      `X broker auth is not implemented yet. Configured X_BROKER_URL=${url}. ` +
        "Broker auth requires implementing a contract to fetch short-lived access tokens."
    );
  }
}
