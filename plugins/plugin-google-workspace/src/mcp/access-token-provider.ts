/**
 * Access-token-only authorization bridge between a Google connector account
 * and an official Workspace MCP resource. The resolver owns OAuth refresh and
 * vault access; this provider exposes only the short-lived bearer required for
 * one MCP operation.
 */
import { ElizaError } from "@elizaos/core";
import type { McpAccessTokenProvider } from "@elizaos/plugin-mcp/resource-engine";
import { GOOGLE_WORKSPACE_MCP_PRODUCT_LABELS } from "@elizaos/shared/contracts";
import type { GoogleCapability } from "../scopes.js";
import type { GoogleAuthClient } from "../types.js";
import type { GoogleMcpProduct } from "./capability-host";

export type GoogleMcpAuthClient = Pick<
  GoogleAuthClient,
  "credentials" | "getAccessToken" | "setCredentials"
>;

export interface GoogleMcpAuthResolutionRequest {
  accountId: string;
  capability: GoogleCapability;
  reason: string;
}

export type GoogleMcpAuthClientResolver = (
  request: GoogleMcpAuthResolutionRequest
) => Promise<GoogleMcpAuthClient>;

/** Every product resolves its `.read` capability; universal search is the one product without a read tier. */
function productAuth(product: GoogleMcpProduct): { capability: GoogleCapability; reason: string } {
  const capability: GoogleCapability =
    product === "universalSearch" ? "workspace.search" : `${product}.read`;
  return {
    capability,
    reason: `Execute ${GOOGLE_WORKSPACE_MCP_PRODUCT_LABELS[product]} through the official Google Workspace MCP resource`,
  };
}

export function createGoogleMcpAccessTokenProvider(options: {
  accountId: string;
  product: GoogleMcpProduct;
  resolveAuthClient: GoogleMcpAuthClientResolver;
}): McpAccessTokenProvider {
  let lastClient: GoogleMcpAuthClient | undefined;
  const resolution = productAuth(options.product);
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
      return { accessToken };
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
