/**
 * Shared helper for connector plugins that resolve the requested account role
 * from an OAuth start flow's metadata.
 *
 * The connector setup UI threads the user's intent (`OWNER`, `AGENT`, or
 * `TEAM`) through `startConnectorAccountOAuth({ metadata: { requestedRole } })`.
 * The cloud-side OAuth pipeline carries that metadata into the
 * `completeOAuth` callback, where each plugin needs to read it and pin the
 * resulting `ConnectorAccount` to the right role.
 *
 * Without this helper each plugin's `completeOAuth` reimplemented the same
 * literal-string narrowing block — and the legacy default of hardcoded
 * `role: "OWNER"` ignored the requested role entirely.
 */

import { logger } from "../logger";
import type { ConnectorAccountRole } from "./account-manager";

const CANONICAL_ROLES = new Set<ConnectorAccountRole>(["OWNER", "AGENT", "TEAM"]);

/**
 * Reads `requestedRole` from an OAuth flow's metadata and returns it as a
 * canonical `ConnectorAccountRole`. Defaults to `"OWNER"` when the field is
 * absent, undefined, or not one of the three canonical values.
 *
 * Emits a debug-level log when a non-empty `requestedRole` was supplied but
 * could not be matched to a canonical role — so misconfiguration surfaces in
 * development without polluting production output. The `src` tag follows the
 * `plugin:<name>:connector` convention used elsewhere in the codebase.
 */
export function readRequestedConnectorRole(
  metadata: Record<string, unknown> | null | undefined,
  src: string,
): ConnectorAccountRole {
  const requestedRoleRaw = metadata?.requestedRole;
  if (
    typeof requestedRoleRaw === "string" &&
    CANONICAL_ROLES.has(requestedRoleRaw as ConnectorAccountRole)
  ) {
    return requestedRoleRaw as ConnectorAccountRole;
  }
  if (requestedRoleRaw !== undefined && requestedRoleRaw !== null) {
    logger.debug(
      { src, requestedRoleRaw },
      "Unrecognised requestedRole in OAuth flow metadata; defaulting to OWNER",
    );
  }
  return "OWNER";
}
