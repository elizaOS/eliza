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
