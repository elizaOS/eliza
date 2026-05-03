/**
 * Application URL for SIWE domain validation and redirects.
 * WHY: SIWE EIP-4361 requires the message domain to match the relying party;
 * we use this as the canonical app origin (no trailing slash).
 */
export function getAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const base = url.startsWith("http") ? url : `https://${url}`;
  return base.replace(/\/$/, "");
}

export function getAppHost(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(getAppUrl(env)).host;
}
