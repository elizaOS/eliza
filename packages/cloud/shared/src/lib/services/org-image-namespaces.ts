/**
 * Per-org container-image namespace extension for the shared image allowlist
 * gate (`isCodingContainerImageAllowed`).
 *
 * WHY: the env allowlists (`CODING_CONTAINER_IMAGE_ALLOWLIST` /
 * `APPS_DEPLOY_IMAGE_ALLOWLIST`) are platform-wide, so a normal user's own
 * registry namespace (e.g. `ghcr.io/<their-github-login>/*`) 403s on every
 * container/app deploy unless an operator widens the GLOBAL list for everyone.
 * This module adds the missing per-tenant dimension: an operator grants ONE org
 * its own namespace(s) without widening the gate for any other org.
 *
 * SOURCE: `organizations.settings.allowed_image_namespaces` (JSONB, string[]).
 * The key is OPERATOR-MANAGED — there is deliberately no self-serve route that
 * writes it (org settings are only written by internal services today). An org
 * granting itself namespaces would defeat the gate, so any future
 * org-facing settings write path must keep this key admin-only.
 *
 * FAIL-CLOSED, defense-in-depth:
 *  - a missing org / missing key / DB error yields [] (deny, never throw);
 *  - entries must be single-namespace registry globs
 *    (`<registry-host>/<namespace>/*`) — a bare `*`, a whole-registry
 *    `ghcr.io/*`, or any malformed entry is dropped, so even a corrupted or
 *    maliciously-written settings row cannot open the gate beyond one
 *    namespace per entry;
 *  - the list is capped so a pathological row cannot bloat the gate.
 */

import { eq } from "drizzle-orm";
import { dbRead } from "../../db/client";
import { organizations } from "../../db/schemas/organizations";
import { logger } from "../utils/logger";

/** settings key read from `organizations.settings` (operator-managed). */
export const ORG_IMAGE_NAMESPACES_SETTINGS_KEY = "allowed_image_namespaces";

/** Upper bound on accepted entries per org (a settings row is not a CSV dump). */
const MAX_ORG_IMAGE_NAMESPACES = 32;

/**
 * The only accepted entry shape: `<registry-host>/<namespace>/*` — a
 * dotted (optionally ported) registry host, exactly one namespace segment,
 * and a trailing `/*`. Structurally forbids `*`, `ghcr.io/*`, exact image
 * refs, and multi-segment paths, keeping each entry scoped to one namespace.
 */
const ORG_IMAGE_NAMESPACE_RE =
  /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?::\d+)?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/\*$/;

/**
 * Normalize + shape-validate a raw settings value into allowlist entries.
 * Pure and fail-closed: anything that is not a well-formed namespace glob is
 * dropped, never widened. Exported for direct testing.
 */
export function normalizeOrgImageNamespaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const entries: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const entry = item.trim().toLowerCase();
    if (!ORG_IMAGE_NAMESPACE_RE.test(entry)) continue;
    if (!entries.includes(entry)) entries.push(entry);
    if (entries.length >= MAX_ORG_IMAGE_NAMESPACES) break;
  }
  return entries;
}

/** The DB seam — narrow settings read, injectable for tests. */
async function readOrgSettings(organizationId: string): Promise<unknown> {
  const [org] = await dbRead
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return (org?.settings as Record<string, unknown> | null | undefined)?.[
    ORG_IMAGE_NAMESPACES_SETTINGS_KEY
  ];
}

/**
 * The org's operator-granted image-namespace allowlist extension. Merged
 * (additively) into the env allowlist at the image-gate call sites; [] for an
 * unknown org, an unset key, or any read failure — the gate stays fail-closed.
 */
export async function getOrgImageNamespaces(
  organizationId: string,
  readSettings: (organizationId: string) => Promise<unknown> = readOrgSettings,
): Promise<string[]> {
  if (!organizationId) return [];
  try {
    return normalizeOrgImageNamespaces(await readSettings(organizationId));
  } catch (error) {
    logger.warn("[OrgImageNamespaces] settings read failed; denying org extension", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
