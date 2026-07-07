/**
 * Web Push VAPID configuration — resolved from cloud secrets.
 *
 * The PUBLIC key is safe to expose to the browser (it's the
 * `applicationServerKey` passed to `pushManager.subscribe`) and is surfaced via
 * the boot-config `webPushVapidPublicKey` field.
 *
 * The PRIVATE key is a CLOUD SECRET. It is read from the Worker env
 * (`process.env` in the Workers runtime maps to the configured secret bindings)
 * and MUST NEVER be committed, logged, or sent to the client.
 *
 * Env vars:
 *   ELIZA_WEB_PUSH_VAPID_PUBLIC_KEY   — base64url uncompressed P-256 point
 *   ELIZA_WEB_PUSH_VAPID_PRIVATE_KEY  — base64url raw P-256 scalar (SECRET)
 *   ELIZA_WEB_PUSH_VAPID_SUBJECT      — mailto:/https contact for the VAPID sub
 */

import type { WebPushVapidConfig } from "./sender";

export const WEB_PUSH_PUBLIC_KEY_ENV = "ELIZA_WEB_PUSH_VAPID_PUBLIC_KEY";
export const WEB_PUSH_PRIVATE_KEY_ENV = "ELIZA_WEB_PUSH_VAPID_PRIVATE_KEY";
export const WEB_PUSH_SUBJECT_ENV = "ELIZA_WEB_PUSH_VAPID_SUBJECT";

/** A minimal env bag so this is testable without the global `process`. */
export type WebPushEnv = Record<string, string | undefined>;

/**
 * Read only the PUBLIC key — safe to inject into served HTML / boot config.
 * Returns `undefined` when unconfigured so the client renders "not configured".
 */
export function getWebPushPublicKey(
  env: WebPushEnv = typeof process !== "undefined" ? process.env : {},
): string | undefined {
  const key = env[WEB_PUSH_PUBLIC_KEY_ENV]?.trim();
  return key ? key : undefined;
}

/**
 * Resolve the full VAPID config (incl. the SECRET private key) for the sender.
 * Returns `null` when any required secret is missing — the caller then no-ops
 * the send rather than throwing, so a cluster without keys configured simply
 * doesn't push.
 */
export function getWebPushVapidConfig(
  env: WebPushEnv = typeof process !== "undefined" ? process.env : {},
): WebPushVapidConfig | null {
  const publicKey = env[WEB_PUSH_PUBLIC_KEY_ENV]?.trim();
  const privateKey = env[WEB_PUSH_PRIVATE_KEY_ENV]?.trim();
  const subject = env[WEB_PUSH_SUBJECT_ENV]?.trim() || "mailto:push@elizacloud.ai";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

/** True when both keys are present (push sending is possible). */
export function isWebPushConfigured(env?: WebPushEnv): boolean {
  return getWebPushVapidConfig(env) !== null;
}
