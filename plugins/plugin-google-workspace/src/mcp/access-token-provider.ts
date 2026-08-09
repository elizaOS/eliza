/**
 * Access-token-only authorization bridge between a Google connector account
 * and an official Workspace MCP resource. The resolver owns OAuth refresh and
 * vault access; this provider exposes only the short-lived bearer required for
 * one MCP operation.
 */
import { ElizaError } from "@elizaos/core";
import type { McpAccessTokenProvider } from "@elizaos/plugin-mcp/resource-engine";
import type { GoogleAuthClient } from "../types.js";
import type { GoogleMcpProduct } from "./capability-host";

export type GoogleMcpAuthClient = Pick<
  GoogleAuthClient,
  "credentials" | "getAccessToken" | "setCredentials"
>;

export interface GoogleMcpAuthResolutionRequest {
  accountId: string;
  capability: "gmail.read" | "calendar.read";
  reason: string;
}

export type GoogleMcpAuthClientResolver = (
  request: GoogleMcpAuthResolutionRequest
) => Promise<GoogleMcpAuthClient>;

const PRODUCT_AUTH = {
  gmail: {
    capability: "gmail.read",
    reason: "Execute Gmail through the official Google Workspace MCP resource",
  },
  calendar: {
    capability: "calendar.read",
    reason: "Execute Calendar through the official Google Workspace MCP resource",
  },
} as const satisfies Record<
  GoogleMcpProduct,
  { capability: GoogleMcpAuthResolutionRequest["capability"]; reason: string }
>;

export function createGoogleMcpAccessTokenProvider(options: {
  accountId: string;
  product: GoogleMcpProduct;
  resolveAuthClient: GoogleMcpAuthClientResolver;
}): McpAccessTokenProvider {
  let lastClient: GoogleMcpAuthClient | undefined;
  const resolution = PRODUCT_AUTH[options.product];
  const resolve = async () => {
    const client = await options.resolveAuthClient({
      accountId: options.accountId,
      capability: resolution.capability,
      reason: resolution.reason,
    });
    lastClient = client;
    return client;
  };
  return {
    getAccessToken: async () => {
      const client = await resolve();
      const response = await client.getAccessToken();
      const accessToken = response.token?.trim();
      if (!accessToken) {
        throw new ElizaError(`Google account ${options.accountId} did not yield an access token`, {
          code: "GOOGLE_MCP_ACCESS_TOKEN_UNAVAILABLE",
          context: { accountId: options.accountId, product: options.product },
        });
      }
      return {
        accessToken,
        ...(typeof client.credentials.expiry_date === "number"
          ? { expiresAt: client.credentials.expiry_date }
          : {}),
      };
    },
    invalidateAccessToken: async () => {
      const client = lastClient ?? (await resolve());
      const {
        access_token: _accessToken,
        expiry_date: _expiryDate,
        ...retained
      } = client.credentials;
      client.setCredentials({ ...retained, expiry_date: 0 });
    },
  };
}
