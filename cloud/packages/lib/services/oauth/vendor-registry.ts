/**
 * Phase 5 SaaS OAuth vendor registry.
 *
 * Distinct from `provider-registry.ts` (which powers the older `/v1/oauth/[platform]/*`
 * flow that stores credentials in `platform_credentials`). This registry powers
 * the simpler `/v1/apis/oauth/{vendor}/*` + `/v1/apis/connections/*` flow that
 * stores envelope-encrypted tokens in `vendor_connections` and vends short-lived
 * access tokens to the agent on demand.
 *
 * Adding a new vendor: append a `VendorConfig` entry below. No route changes
 * required — the dynamic `[vendor]` segments dispatch based on this registry.
 */

import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

export type VendorId = "linear" | "shopify" | "calendly";

export interface VendorAuthorizeContext {
  /**
   * Per-shop authorize URL templates. Shopify needs `{shop}` substitution from
   * the start request body; vendors with a static URL ignore this.
   */
  shop?: string;
}

export interface VendorTokenContext {
  shop?: string;
}

export interface VendorConfig {
  id: VendorId;
  /** Human-readable name shown in errors and connection lists. */
  name: string;
  /** Default scopes requested when the caller doesn't provide any. */
  defaultScopes: string[];
  /** Env var name for the OAuth client ID. */
  clientIdEnv: string;
  /** Env var name for the OAuth client secret. */
  clientSecretEnv: string;
  /**
   * Builds the upstream authorize URL. `state` is signed/opaque to the vendor.
   * For Shopify, `ctx.shop` is required and substituted into the host.
   */
  buildAuthorizeUrl(args: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    ctx: VendorAuthorizeContext;
  }): string;
  /**
   * Returns the token-exchange URL. For Shopify this varies per shop.
   */
  buildTokenUrl(ctx: VendorTokenContext): string;
  /**
   * Whether this vendor needs `label` set to a per-tenant identifier (e.g.
   * Shopify uses the shop subdomain). When true, `connectionMetadata.shop_domain`
   * MUST also be set.
   */
  perTenant: boolean;
  /** Documentation URL surfaced in the env example and error messages. */
  docsUrl: string;
}

export const VENDOR_REGISTRY: Record<VendorId, VendorConfig> = {
  linear: {
    id: "linear",
    name: "Linear",
    defaultScopes: ["read", "write", "issues:create", "comments:create"],
    clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
    clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
    buildAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(","),
        state,
        actor: "user",
      });
      return `https://linear.app/oauth/authorize?${params.toString()}`;
    },
    buildTokenUrl() {
      return "https://api.linear.app/oauth/token";
    },
    perTenant: false,
    docsUrl: "https://developers.linear.app/docs/oauth/authentication",
  },
  shopify: {
    id: "shopify",
    name: "Shopify",
    defaultScopes: [
      "read_products",
      "write_products",
      "read_orders",
      "write_orders",
      "read_customers",
      "write_inventory",
    ],
    clientIdEnv: "SHOPIFY_OAUTH_CLIENT_ID",
    clientSecretEnv: "SHOPIFY_OAUTH_CLIENT_SECRET",
    buildAuthorizeUrl({ clientId, redirectUri, scopes, state, ctx }) {
      if (!ctx.shop) {
        throw new Error(
          "Shopify authorize URL requires a `shop` subdomain — pass `shop` in the start request body",
        );
      }
      const params = new URLSearchParams({
        client_id: clientId,
        scope: scopes.join(","),
        redirect_uri: redirectUri,
        state,
      });
      return `https://${ctx.shop}.myshopify.com/admin/oauth/authorize?${params.toString()}`;
    },
    buildTokenUrl(ctx) {
      if (!ctx.shop) {
        throw new Error(
          "Shopify token URL requires a `shop` subdomain (preserved from /start in OAuth state)",
        );
      }
      return `https://${ctx.shop}.myshopify.com/admin/oauth/access_token`;
    },
    perTenant: true,
    docsUrl:
      "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant",
  },
  calendly: {
    id: "calendly",
    name: "Calendly",
    defaultScopes: ["default"],
    clientIdEnv: "CALENDLY_OAUTH_CLIENT_ID",
    clientSecretEnv: "CALENDLY_OAUTH_CLIENT_SECRET",
    buildAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
      });
      // Calendly accepts `default` as an opaque scope sentinel; if any other
      // scope is requested, propagate it as `scope=`.
      if (scopes.length > 0 && !(scopes.length === 1 && scopes[0] === "default")) {
        params.set("scope", scopes.join(" "));
      }
      return `https://auth.calendly.com/oauth/authorize?${params.toString()}`;
    },
    buildTokenUrl() {
      return "https://auth.calendly.com/oauth/token";
    },
    perTenant: false,
    docsUrl: "https://developer.calendly.com/api-docs/ZG9jOjE2MDM0MTAy-oauth-2-0",
  },
};

export function getVendor(id: string): VendorConfig | null {
  return id in VENDOR_REGISTRY ? VENDOR_REGISTRY[id as VendorId] : null;
}

export function isVendorConfigured(vendor: VendorConfig): boolean {
  const env = getCloudAwareEnv();
  return Boolean(env[vendor.clientIdEnv] && env[vendor.clientSecretEnv]);
}

export function getVendorClientCreds(
  vendor: VendorConfig,
): { clientId: string; clientSecret: string } | null {
  const env = getCloudAwareEnv();
  const clientId = env[vendor.clientIdEnv];
  const clientSecret = env[vendor.clientSecretEnv];
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}
