/**
 * Application URL for SIWE domain validation and redirects.
 * WHY: SIWE EIP-4361 requires the message domain to match the relying party;
 * we use this as the canonical app origin (no trailing slash).
 *
 * NOTE for Cloudflare Worker callers: `process.env` is empty under Workers
 * (bindings live on `c.env`). Always pass the request env explicitly:
 * `getAppUrl(c.env)` / `getAppHost(c.env)`. The `process.env` default is only
 * appropriate for the browser bundle (Vite replaces `process.env.NEXT_PUBLIC_*`
 * at build time) and Node tests.
 */
interface AppUrlEnv {
  NEXT_PUBLIC_APP_URL?: unknown;
  [key: string]: unknown;
}

export function getAppUrl(env: AppUrlEnv = process.env): string {
  const configuredUrl =
    typeof env.NEXT_PUBLIC_APP_URL === "string" ? env.NEXT_PUBLIC_APP_URL : undefined;
  const url = configuredUrl || "http://localhost:3000";
  const base = url.startsWith("http") ? url : `https://${url}`;
  return base.replace(/\/$/, "");
}

export function getAppHost(env: AppUrlEnv = process.env): string {
  return new URL(getAppUrl(env)).host;
}
