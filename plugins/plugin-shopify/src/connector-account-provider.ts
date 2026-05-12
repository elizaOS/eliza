/**
 * Shopify ConnectorAccountManager provider.
 *
 * Bridges plugin-shopify to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface can list, create, patch, delete, and run
 * the OAuth flow for Shopify stores.
 *
 * Account model:
 *   - role "OWNER" — store admin (Shopify Admin API access token)
 *   - accountKey  — store domain (e.g. mystore.myshopify.com)
 *   - purpose     — ["admin"]
 */

import {
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorAccountPurpose,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import { readShopifyAccounts } from "./accounts.js";

export const SHOPIFY_PROVIDER_NAME = "shopify";

const DEFAULT_PURPOSES: ConnectorAccountPurpose[] = [
  "admin" as ConnectorAccountPurpose,
];

interface ShopifyTokenResponse {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface ShopifyShopPayload {
  shop?: {
    id?: number;
    name?: string;
    email?: string;
    domain?: string;
    myshopify_domain?: string;
    plan_name?: string;
    currency?: string;
    country_code?: string;
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return nonEmptyString(runtime.getSetting?.(key));
}

function readClientConfig(runtime: IAgentRuntime): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = readSetting(runtime, "SHOPIFY_OAUTH_CLIENT_ID");
  const clientSecret = readSetting(runtime, "SHOPIFY_OAUTH_CLIENT_SECRET");
  const redirectUri = readSetting(runtime, "SHOPIFY_OAUTH_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Shopify OAuth requires SHOPIFY_OAUTH_CLIENT_ID, SHOPIFY_OAUTH_CLIENT_SECRET, and SHOPIFY_OAUTH_REDIRECT_URI to be configured.",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function parseScopes(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function normalizeStoreDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.endsWith(".myshopify.com")) return trimmed;
  if (trimmed.includes(".")) return trimmed;
  return `${trimmed}.myshopify.com`;
}

async function exchangeCodeForToken(args: {
  storeDomain: string;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<ShopifyTokenResponse> {
  const url = `https://${args.storeDomain}/admin/oauth/access_token`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Shopify token exchange failed with ${response.status}: ${body}`,
    );
  }
  const parsed = (await response.json()) as ShopifyTokenResponse;
  if (parsed.error) {
    throw new Error(
      `Shopify token exchange returned error ${parsed.error}: ${parsed.error_description ?? "no description"}`,
    );
  }
  if (!parsed.access_token) {
    throw new Error("Shopify token exchange returned no access_token.");
  }
  return parsed;
}

async function fetchShopInfo(
  storeDomain: string,
  accessToken: string,
): Promise<ShopifyShopPayload> {
  const url = `https://${storeDomain}/admin/api/2024-10/shop.json`;
  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Shopify shop.json query failed with ${response.status}`);
  }
  return (await response.json()) as ShopifyShopPayload;
}

function synthesizeEnvAccounts(runtime: IAgentRuntime): ConnectorAccount[] {
  const now = Date.now();
  return readShopifyAccounts(runtime).map((account) => ({
    id: account.accountId,
    provider: SHOPIFY_PROVIDER_NAME,
    label: account.label ?? `Shopify (${account.storeDomain})`,
    role: "OWNER" as const,
    purpose: DEFAULT_PURPOSES,
    accessGate: "open" as const,
    status: "connected" as const,
    externalId: account.storeDomain,
    displayHandle: account.storeDomain,
    createdAt: now,
    updatedAt: now,
    metadata: {
      authMethod: "access_token",
      source: "env",
      storeDomain: account.storeDomain,
    },
  }));
}

/**
 * Build the Shopify ConnectorAccountManager provider.
 */
export function createShopifyConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: SHOPIFY_PROVIDER_NAME,
    label: "Shopify",

    listAccounts: async (
      manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const stored = await manager
        .getStorage()
        .listAccounts(SHOPIFY_PROVIDER_NAME);
      if (stored.length > 0) return stored;
      return synthesizeEnvAccounts(runtime);
    },

    createAccount: async (
      input: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return {
        ...input,
        provider: SHOPIFY_PROVIDER_NAME,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? DEFAULT_PURPOSES,
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return { ...patch, provider: SHOPIFY_PROVIDER_NAME };
    },

    deleteAccount: async (
      _accountId: string,
      _manager: ConnectorAccountManager,
    ): Promise<void> => {
      // Credential cleanup is the credential store's responsibility.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readClientConfig(runtime);
      const redirectUri = request.redirectUri ?? config.redirectUri;
      const metadataInput =
        (request.metadata as Record<string, unknown> | undefined) ?? {};
      const storeDomainRaw =
        nonEmptyString(metadataInput.storeDomain) ??
        nonEmptyString(metadataInput.shopDomain) ??
        nonEmptyString(metadataInput.shop);
      if (!storeDomainRaw) {
        throw new Error(
          "Shopify OAuth requires a storeDomain (e.g. mystore.myshopify.com) in startOAuth metadata.",
        );
      }
      const storeDomain = normalizeStoreDomain(storeDomainRaw);
      const scopes =
        request.scopes && request.scopes.length > 0
          ? request.scopes
          : [
              "read_products",
              "write_products",
              "read_orders",
              "write_orders",
              "read_customers",
              "read_inventory",
              "write_inventory",
              "read_locations",
            ];

      const params = new URLSearchParams({
        client_id: config.clientId,
        scope: scopes.join(","),
        redirect_uri: redirectUri,
        state: request.flow.state,
      });

      return {
        authUrl: `https://${storeDomain}/admin/oauth/authorize?${params.toString()}`,
        metadata: {
          ...request.metadata,
          requestedScopes: scopes,
          redirectUri,
          storeDomain,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new Error(
          "Shopify OAuth callback is missing an authorization code.",
        );
      }

      const flowMetadata =
        (request.flow.metadata as Record<string, unknown> | undefined) ?? {};
      const storeDomainRaw =
        nonEmptyString(flowMetadata.storeDomain) ??
        nonEmptyString(request.query.shop);
      if (!storeDomainRaw) {
        throw new Error(
          "Shopify OAuth callback could not resolve a storeDomain.",
        );
      }
      const storeDomain = normalizeStoreDomain(storeDomainRaw);

      const config = readClientConfig(runtime);
      const tokens = await exchangeCodeForToken({
        storeDomain,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
      });
      if (!tokens.access_token) {
        throw new Error("Shopify token exchange returned no access_token.");
      }

      const shopPayload = await fetchShopInfo(storeDomain, tokens.access_token);
      const shop = shopPayload.shop;
      const externalId = nonEmptyString(
        shop?.myshopify_domain ?? shop?.domain ?? storeDomain,
      );
      if (!externalId) {
        throw new Error(
          "Shopify shop payload did not include a usable domain.",
        );
      }

      const accountPatch: ConnectorAccountPatch & { provider: string } = {
        provider: SHOPIFY_PROVIDER_NAME,
        role: "OWNER",
        purpose: DEFAULT_PURPOSES,
        accessGate: "open",
        status: "connected",
        externalId,
        displayHandle: externalId,
        label: nonEmptyString(shop?.name) ?? externalId,
        metadata: {
          authMethod: "oauth",
          storeDomain,
          shopId: shop?.id ?? null,
          shopName: nonEmptyString(shop?.name) ?? null,
          shopEmail: nonEmptyString(shop?.email) ?? null,
          planName: nonEmptyString(shop?.plan_name) ?? null,
          currency: nonEmptyString(shop?.currency) ?? null,
          countryCode: nonEmptyString(shop?.country_code) ?? null,
          grantedScopes: parseScopes(tokens.scope),
        },
      };

      logger.info(
        {
          src: "plugin:shopify:connector",
          storeDomain,
        },
        "Shopify OAuth completed",
      );

      return {
        account: accountPatch,
        flow: { status: "completed" },
      };
    },
  };
}
