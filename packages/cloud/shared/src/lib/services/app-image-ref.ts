/**
 * Pure image-reference derivation for the Apps / Product 2 build pipeline.
 *
 * A user app is built into an OCI image tagged per app + source ref, pushed to a
 * registry, and resolved at deploy to run as an isolated container. These pure
 * helpers turn (registry, appId, sourceRef) into a stable, registry-safe
 * `<registry>/app-<slug>:<tag>` — no IO, so the naming contract is unit-tested.
 *
 * The app slug mirrors `deriveTenantIdent`'s slugging so an app's image, tenant
 * DB, role, and container name all key off the same stable short id.
 */

/** Chars not allowed in a docker tag are collapsed to `-`. */
const TAG_UNSAFE = /[^a-zA-Z0-9_.-]/g;

/** Short, registry-safe slug of an app id (mirrors deriveTenantIdent's slug). */
export function appImageSlug(appId: string): string {
  const slug = appId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 24);
  if (slug.length < 8) {
    throw new Error(`appImageSlug: appId ${appId} yields too short a slug (${slug.length})`);
  }
  return slug;
}

/**
 * Normalize a source ref (git sha or branch) into a valid docker tag. Docker
 * tags can't start with `.`/`-` and are ≤128 chars; anything unsafe collapses
 * to `-`. An empty/absent ref yields `latest`.
 */
export function deriveImageTag(sourceRef?: string): string {
  if (!sourceRef) return "latest";
  const tag = sourceRef
    .replace(TAG_UNSAFE, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 128);
  return tag.length > 0 ? tag : "latest";
}

export interface AppImageRefParams {
  /** Registry + namespace, e.g. `ghcr.io/elizaos` or `registry.local:5000/apps`. */
  registry: string;
  appId: string;
  /** Git sha/branch the image was built from; omitted → `latest`. */
  sourceRef?: string;
}

/** Build the full image reference `<registry>/app-<slug>:<tag>`. */
export function buildAppImageRef(params: AppImageRefParams): string {
  const registry = params.registry.replace(/\/+$/, "");
  // Registry may carry a host, optional :port, and a namespace path.
  if (!/^[a-zA-Z0-9._:/-]+$/.test(registry) || registry.length === 0) {
    throw new Error(`buildAppImageRef: invalid registry "${params.registry}"`);
  }
  return `${registry}/app-${appImageSlug(params.appId)}:${deriveImageTag(params.sourceRef)}`;
}
