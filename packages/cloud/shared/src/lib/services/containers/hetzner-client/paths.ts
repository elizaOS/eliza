/**
 * Path derivation and input validation helpers.
 *
 * Pure functions that turn user-supplied identifiers into safe host-side
 * paths and Docker names. All path-construction logic that touches user
 * input lives here so the sanitisation rules are in one place.
 */

import { containersEnv } from "../../../config/containers-env";
import { DEFAULT_VOLUME_MOUNT_PATH } from "./constants";
import { HetznerClientError } from "./types";

/** Generate a Docker-safe container name from the DB id. */
export function deriveContainerName(containerId: string): string {
  return `cloud-container-${containerId.replace(/-/g, "")}`;
}

/**
 * Build the public hostname for a container under the configured base
 * domain. Uses a short id slice so the URL is short and shareable while
 * staying collision-resistant. Returns null when no base domain is set.
 */
export function derivePublicHostname(containerId: string): string | null {
  const baseDomain = containersEnv.publicBaseDomain();
  if (!baseDomain) return null;
  // 8 hex chars from the (UUID v4) container id is enough for ≪10^9 IDs
  // before a meaningful collision risk; the full id is still the unique
  // key in the DB so a duplicate hostname would simply collide on the
  // index and surface as an error to the operator.
  const shortId = containerId.replace(/-/g, "").slice(0, 8);
  return `${shortId}.${baseDomain}`;
}

/**
 * Host filesystem path for a project's persistent volume.
 *
 * Treats `(organizationId, projectName)` as the durable agent identity:
 * redeploying a container with the same project_name in the same org
 * reuses this path, so the agent's data survives container replacement.
 * The org_id prefix isolates volumes between tenants on shared hosts.
 *
 * Path is sanitized — project names go through a strict slug filter so a
 * user-supplied name cannot escape the volume root via shell or path
 * tricks. The schema already validates project_name length and shape,
 * but this is a belt-and-braces guard.
 */
export function deriveVolumePath(organizationId: string, projectName: string): string {
  const safeOrg = organizationId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeProject = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 64);
  if (!safeOrg || !safeProject) {
    throw new HetznerClientError(
      "invalid_input",
      `Cannot derive volume path from organizationId="${organizationId}" projectName="${projectName}"`,
    );
  }
  return `/data/projects/${safeOrg}/${safeProject}`;
}

export function validateEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new HetznerClientError(
      "invalid_input",
      `Invalid environment variable name: '${key}'. Must start with letter/underscore and contain only alphanumeric and underscores.`,
    );
  }
}

export function validateContainerMountPath(value: string | undefined): string {
  if (!value) return DEFAULT_VOLUME_MOUNT_PATH;
  const normalized = value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (
    normalized === "/" ||
    !normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new HetznerClientError(
      "invalid_input",
      `Invalid volume mount path: ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}
