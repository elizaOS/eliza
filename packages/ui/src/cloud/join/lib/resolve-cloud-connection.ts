/**
 * Resolve the Cloud connection inputs the join flow hands to
 * `selectOrProvisionCloudAgent`: the direct-cloud API origin and the Steward
 * session token.
 *
 * Auth model (DECISIONS.md D3): Cloud = Steward, unified across web AND native.
 * The Steward JWT in `localStorage.steward_session_token` is the canonical auth
 * source for every Cloud connection, so the join flow reads it directly via the
 * shared steward-session client rather than the legacy `__ELIZA_CLOUD_AUTH_TOKEN__`
 * global.
 */

import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { getBootConfig } from "../../../config/boot-config";

/** Fallback direct-cloud origin used when boot config carries no `cloudApiBase`. */
const DEFAULT_CLOUD_API_BASE = "https://www.elizacloud.ai";

/**
 * The resolved direct-cloud origin the join flow provisions against. Prefers the
 * boot-config `cloudApiBase` (host app injects it); falls back to the public
 * Eliza Cloud origin. `selectOrProvisionCloudAgent` re-normalizes this to the
 * `api.elizacloud.ai` auth base internally, so passing the web origin is fine.
 */
export function resolveJoinCloudApiBase(): string {
  const configured = getBootConfig().cloudApiBase?.trim();
  return configured || DEFAULT_CLOUD_API_BASE;
}

/** The Steward session token, or `null` when the user is signed out. */
export function resolveJoinAuthToken(): string | null {
  return readStoredStewardToken()?.trim() || null;
}
