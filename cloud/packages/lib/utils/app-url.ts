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
/**
 * Structural minimum the helpers actually read.
 * Accepts Node `ProcessEnv` (string-record), Cloudflare `Bindings`, or any
 * other shape that exposes the URL key. The default uses `process.env`,
 * cast through `as AppUrlEnv` because `ProcessEnv` is a string index
 * signature with no nominal `NEXT_PUBLIC_APP_URL` property — TS can't
 * structurally see the overlap, but the runtime read is safe.
 */
export type AppUrlEnv = { NEXT_PUBLIC_APP_URL?: string | undefined };

export function getAppUrl(env: AppUrlEnv = process.env as AppUrlEnv): string {
  const url = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const base = url.startsWith("http") ? url : `https://${url}`;
  return base.replace(/\/$/, "");
}

export function getAppHost(env: AppUrlEnv = process.env as AppUrlEnv): string {
  return new URL(getAppUrl(env)).host;
}
