/**
 * Browser stub for `@vercel/oidc`: Vercel OIDC token exchange is a server-side
 * concern with no meaning in the app renderer, so this aliases the module to
 * empty-token getters and no-op error classes, keeping the server-only OIDC
 * code out of the browser bundle.
 */
export class AccessTokenMissingError extends Error {}
export class RefreshAccessTokenFailedError extends Error {}

export function getContext(): Record<string, never> {
  return {};
}

export async function getVercelOidcToken(): Promise<string> {
  return "";
}

export function getVercelOidcTokenSync(): string {
  return "";
}

export async function getVercelToken(): Promise<string> {
  return "";
}
