/**
 * Resolve a Docker image reference (e.g. `ghcr.io/elizaos/eliza:develop`) to
 * its registry-side sha256 digest. The fleet-upgrade reconciler uses this to
 * detect when a tag has been republished (i.e. a new image was pushed under
 * the same name), and then triggers a rolling blue/green upgrade of all
 * agents still on the old digest.
 *
 * Only ghcr.io is supported. Anything else — including a bare image name
 * without a registry prefix like `eliza-agent:prod-good` — resolves to
 * `null`, which the reconciler treats as "skip, don't know how to upgrade".
 */
import { logger } from "../../utils/logger";

const CACHE_TTL_MS = 60_000;

/**
 * Per-request cap on the two ghcr.io HTTP calls (token + manifest HEAD). These
 * were the one genuinely-unbounded leaf in the provisioning cycle — a hung
 * ghcr connection could stall the fleet-upgrade reconciler indefinitely.
 * `resolveImageDigest` already returns null on any failure and callers treat
 * null as "skip, retry next tick", so bounding adds no behavior change.
 */
const REGISTRY_FETCH_TIMEOUT_MS = 5_000;

interface CacheEntry {
  digest: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

interface ResolveOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
}

export async function resolveImageDigest(
  imageRef: string,
  opts: ResolveOptions = {},
): Promise<string | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;

  const cached = cache.get(imageRef);
  if (cached && cached.expiresAt > now()) return cached.digest;

  // A digest-pinned ref (`repo@sha256:...`) is already resolved — the digest IS
  // the answer, and there is no newer digest to fetch. Short-circuit before the
  // tag path: parseImageRef would keep the `@sha256` in the repo
  // (`elizaos/eliza@sha256`), corrupting the ghcr token scope
  // `repository:<repo>:pull` → HTTP 400, which makes the fleet-upgrade probe
  // skip every digest-pinned fleet (the prod agent image is digest-pinned).
  const atIdx = imageRef.indexOf("@");
  if (atIdx !== -1) {
    const digest = imageRef.slice(atIdx + 1);
    const resolved = /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
    cache.set(imageRef, { digest: resolved, expiresAt: now() + CACHE_TTL_MS });
    return resolved;
  }

  const parsed = parseImageRef(imageRef);
  if (!parsed || parsed.registry !== "ghcr.io") {
    cache.set(imageRef, { digest: null, expiresAt: now() + CACHE_TTL_MS });
    return null;
  }

  const digest = await fetchGhcrDigest(parsed.repo, parsed.tag, fetchFn);
  cache.set(imageRef, { digest, expiresAt: now() + CACHE_TTL_MS });
  return digest;
}

interface ParsedRef {
  registry: string;
  repo: string;
  tag: string;
}

export function parseImageRef(ref: string): ParsedRef | null {
  // A real Docker reference is `host[:port]/path:tag`. The tag is the
  // substring after the last colon, but only if that colon comes after the
  // last slash (otherwise it's a port number inside the registry host).
  const lastColon = ref.lastIndexOf(":");
  const lastSlash = ref.lastIndexOf("/");
  if (lastColon === -1 || lastColon < lastSlash) return null;
  const tag = ref.slice(lastColon + 1);
  if (!tag) return null;

  const repoFull = ref.slice(0, lastColon);
  const firstSlash = repoFull.indexOf("/");
  if (firstSlash === -1) return null;

  const registry = repoFull.slice(0, firstSlash);
  // Heuristic: a real registry host has either a dot (ghcr.io, docker.io) or
  // a port. Single-token prefixes like `eliza-agent` are local image names,
  // not registries, and `host[firstSlash]/path` would actually be the repo.
  if (!registry.includes(".") && !registry.includes(":")) return null;

  const repo = repoFull.slice(firstSlash + 1);
  if (!repo) return null;

  return { registry, repo, tag };
}

async function fetchGhcrDigest(
  repo: string,
  tag: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  // Encode each path segment but preserve `/` between them: a Docker repo
  // like `elizaos/eliza` is valid in the URL path, but a stray space or `?`
  // in a segment would silently produce a malformed URL.
  const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
  const encodedTag = encodeURIComponent(tag);

  let token: string;
  try {
    const tokenResp = await fetchFn(
      `https://ghcr.io/token?scope=repository:${encodedRepo}:pull&service=ghcr.io`,
      { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) },
    );
    if (!tokenResp.ok) {
      logger.warn(`[registry-probe] ghcr token fetch failed for ${repo}: ${tokenResp.status}`);
      return null;
    }
    const tokenJson = (await tokenResp.json()) as { token?: string };
    if (!tokenJson.token) return null;
    token = tokenJson.token;
  } catch (err) {
    // error-policy:J7 best-effort ghcr probe for a retrying reconciler. This is
    // an outbound-HTTP transport boundary whose only consumers (fleet-upgrade
    // reconciler tick + post-provision metadata read) treat null as "digest
    // unknown → skip, retry next tick"; a transport error must not abort an
    // already-provisioned container or kill the reconciler loop. Surface it via
    // warn (distinct from the silent designed-empty paths) and fail safe to null
    // — the risky action (blue/green upgrade) is what gets skipped.
    logger.warn(
      `[registry-probe] ghcr token network error for ${repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  try {
    const manifestResp = await fetchFn(
      `https://ghcr.io/v2/${encodedRepo}/manifests/${encodedTag}`,
      {
        method: "HEAD",
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: [
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.docker.distribution.manifest.v2+json",
          ].join(", "),
        },
      },
    );
    if (!manifestResp.ok) {
      if (manifestResp.status !== 404) {
        logger.warn(
          `[registry-probe] ghcr manifest fetch failed for ${repo}:${tag}: ${manifestResp.status}`,
        );
      }
      return null;
    }
    return manifestResp.headers.get("docker-content-digest");
  } catch (err) {
    // error-policy:J7 same best-effort reconciler-probe boundary as the token
    // fetch above: a manifest-HEAD transport error surfaces via warn and fails
    // safe to null so the caller skips + retries, never aborting provisioning.
    logger.warn(
      `[registry-probe] ghcr manifest network error for ${repo}:${tag}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Test-only: clears the in-process cache between scenarios. */
export function clearRegistryProbeCache(): void {
  cache.clear();
}
