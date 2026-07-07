/**
 * Web Push VAPID configuration — resolved from cloud secrets.
 *
 * The PUBLIC key is safe to expose to the browser (it's the
 * `applicationServerKey` passed to `pushManager.subscribe`) and is surfaced via
 * the boot-config `webPushVapidPublicKey` field.
 *
 * The PRIVATE key is a CLOUD SECRET. Worker call sites pass the request `c.env`
 * bindings explicitly; Node/test call sites may rely on `process.env`. The key
 * MUST NEVER be committed, logged, or sent to the client.
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
export type WebPushEnv = Record<string, unknown>;

function readStringBinding(env: WebPushEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Read only the PUBLIC key — safe to inject into served HTML / boot config.
 * Returns `undefined` when unconfigured so the client renders "not configured".
 */
export function getWebPushPublicKey(
  env: WebPushEnv = typeof process !== "undefined" ? process.env : {},
): string | undefined {
  return readStringBinding(env, WEB_PUSH_PUBLIC_KEY_ENV);
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
  const publicKey = readStringBinding(env, WEB_PUSH_PUBLIC_KEY_ENV);
  const privateKey = readStringBinding(env, WEB_PUSH_PRIVATE_KEY_ENV);
  const subject = readStringBinding(env, WEB_PUSH_SUBJECT_ENV) ?? "mailto:push@elizacloud.ai";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

/** True when both keys are present (push sending is possible). */
export function isWebPushConfigured(env?: WebPushEnv): boolean {
  return getWebPushVapidConfig(env) !== null;
}
