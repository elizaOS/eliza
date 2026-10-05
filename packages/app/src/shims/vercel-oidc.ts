/**
 * Browser stub for `@vercel/oidc`: Vercel OIDC token exchange is a server-side
 * concern with no meaning in the app renderer, so this aliases the module to
 * explicit missing-token failures, keeping the server-only OIDC
 * code out of the browser bundle.
 */
export class AccessTokenMissingError extends Error {
  constructor() {
    super("Vercel OIDC token exchange is unavailable in the browser renderer.");
    this.name = "AccessTokenMissingError";
  }
}
export class RefreshAccessTokenFailedError extends Error {}

export function getContext(): Record<string, never> {
  return {};
}

export async function getVercelOidcToken(): Promise<string> {
  throw new AccessTokenMissingError();
}

export function getVercelOidcTokenSync(): string {
  throw new AccessTokenMissingError();
}

export async function getVercelToken(): Promise<string> {
  throw new AccessTokenMissingError();
}
