/**
 * Helpers for reading credentials projected into pods via the
 * Kubernetes ServiceAccount admission controller.
 *
 * Both helpers return `null` when not running in a cluster (the secret
 * files are absent on a developer laptop) and cache the result on first
 * successful read.
 */

import { readFileSync } from "node:fs";

const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const CA_CERT_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

let cachedToken: string | null | undefined;
let cachedCaCert: string | null | undefined;

/**
 * Reads the projected service-account token. Returns `null` when the
 * file is missing or unreadable (e.g. running locally outside a cluster).
 */
export function readServiceAccountToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const token = readFileSync(TOKEN_PATH, "utf-8").trim();
    cachedToken = token.length > 0 ? token : null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

/**
 * Reads the projected service-account CA bundle. Returns `null` when the
 * file is missing or unreadable.
 */
export function readServiceAccountCaCert(): string | null {
  if (cachedCaCert !== undefined) return cachedCaCert;
  try {
    const ca = readFileSync(CA_CERT_PATH, "utf-8");
    cachedCaCert = ca.length > 0 ? ca : null;
  } catch {
    cachedCaCert = null;
  }
  return cachedCaCert;
}

/**
 * Test-only: reset the in-memory token/CA cache. Production code should
 * never call this.
 */
export function __resetServiceAccountCacheForTests(): void {
  cachedToken = undefined;
  cachedCaCert = undefined;
}
