/**
 * Build-from-repo image resolver (Apps / Product 2) — connects the build
 * pipeline to the deploy runner. Returns a `resolveImage` (the shape
 * `AppDeployRunner` calls) that BUILDS the app's image from its git repo via
 * {@link AppImageBuilder} and returns the pushed, resolvable ref.
 *
 * Returns `undefined` when the app has no repo, so the deploy runner falls
 * through to `app.metadata.imageTag` / `APP_DEFAULT_IMAGE` for legacy/prebuilt
 * lanes — never an error for the no-repo case.
 *
 * Docker builds git URLs natively (`docker build <git-url>#ref:subdir`), so the
 * repo URL is passed straight through as the build context — no clone step.
 *
 * IMMUTABLE IMAGES (#13097): the build-from-repo resolver returns the
 * digest-pinned ref from {@link AppImageBuilder.build} — `repo@sha256:<64hex>`,
 * captured atomically from the build invocation. The prebuilt-image map
 * resolver pins the known first-party showcase mappings to digest refs so a
 * configured `APP_PREBUILT_IMAGES` cannot silently carry a mutable tag.
 */

import { logger } from "../utils/logger";
import {
  type ImagePreflightEntry,
  scanImageRefsForMutableTags,
} from "./app-deploy-image-preflight";
import type { AppImageBuilder } from "./app-image-builder";

/**
 * A `resolveImage` the deploy runner calls; undefined → fall through. Matches
 * `AppDeployRunnerDeps["resolveImage"]` exactly (sync or async return) so the
 * resolvers here are interchangeable with the runner's option.
 */
export type AppImageResolver = (
  app: ResolverApp,
) => Promise<string | undefined> | string | undefined;

export interface BuildFromRepoResolverDeps {
  builder: AppImageBuilder;
  /** Registry the image is tagged + pushed to. */
  registry: string;
  /** Dockerfile path within the repo. Default: docker's `Dockerfile`. */
  dockerfile?: string;
}

interface ResolverApp {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  /** apps.github_repo — the primary build context source. */
  repoUrl?: string;
}

function buildContextFor(repo: string, sourceRef?: string): string {
  if (!sourceRef || repo.includes("#")) return repo;
  return `${repo}#${sourceRef}`;
}

/**
 * Known first-party showcase image digests — pinned so the default
 * `APP_PREBUILT_IMAGES` mappings are content-addressed, not mutable tags
 * (#13097). Resolved via `docker buildx imagetools inspect` on 2026-08-13;
 * re-pin after every future production image publish.
 *
 * When an operator configures `APP_PREBUILT_IMAGES` with a mutable tag that
 * matches a known first-party repo, the digest is applied automatically. Custom
 * (non-first-party) refs are passed through as-is — the preflight scan flags
 * them if the digest gate is armed.
 */
const FIRST_PARTY_DIGEST_PINS: Record<string, string> = {
  "ghcr.io/elizaos/example-edad:showcase":
    "ghcr.io/elizaos/example-edad@sha256:a1b32e421ac1a7a3b3e1485fa34ceced6dec756893baf8bc9022298c3f6d0f88",
  "ghcr.io/elizaos/example-clone-ur-crush:showcase":
    "ghcr.io/elizaos/example-clone-ur-crush@sha256:0c69b045f44e799f4415d346450713c49129793c45caccb8512deeee5d6701f7",
};

/**
 * Pin a known first-party mutable tag to its digest ref. Returns the original
 * ref unchanged when it is not a recognized first-party mutable tag (already
 * digest-pinned, a custom repo, or a tag without a published digest).
 */
function pinFirstPartyDigest(ref: string): string {
  const trimmed = ref.trim();
  // Already digest-pinned — leave as-is.
  if (trimmed.includes("@sha256:")) return trimmed;
  const pinned = FIRST_PARTY_DIGEST_PINS[trimmed];
  return pinned ?? trimmed;
}

/**
 * Scan configured + default image refs for mutable tags and log findings. Called
 * at preflight/startup before arming the digest gate so a misconfiguration
 * surfaces actionably instead of causing deploy-time rejections (#13097).
 *
 * Pure except for logging; takes the entries to scan + the digest requirement
 * flag. Returns the structured result so the caller can fail-closed on mutable
 * refs in production.
 */
export function preflightImageRefs(entries: ImagePreflightEntry[], requireDigest: boolean) {
  const result = scanImageRefsForMutableTags(entries, requireDigest);
  for (const finding of result.mutableRefs) {
    logger.warn(`[AppImageResolver] ${finding.warning}`);
  }
  return result;
}

/**
 * Per-app prebuilt-image resolver (#9300). Lets an operator deploy MORE THAN ONE
 * distinct prebuilt app on real staging without a per-app git build: a single
 * `APP_DEFAULT_IMAGE` can only point at one image, and `metadata.imageTag` is not
 * settable over the REST apps-create API, so two distinct showcase apps (EDAD +
 * Clone Ur Crush) would otherwise both resolve to the SAME default image.
 *
 * Reads `APP_PREBUILT_IMAGES` — a JSON object mapping an app-NAME PREFIX to an
 * image ref, e.g.
 *   {"eDad Showcase":"ghcr.io/elizaos/example-edad:showcase",
 *    "Clone Your Crush Showcase":"ghcr.io/elizaos/example-clone-ur-crush:showcase"}
 * and returns the image whose prefix is the LONGEST match for `app.name` (so the
 * showcase specs' timestamped names — "eDad Showcase 1a2b3c" — still match).
 *
 * IMMUTABLE IMAGES (#13097): known first-party mutable tags are automatically
 * pinned to their digests (see {@link pinFirstPartyDigest}). Custom refs are
 * passed through — the preflight scan ({@link preflightImageRefs}) flags them
 * when the digest gate is armed.
 *
 * Returns `undefined` (no resolver) when the env is unset / empty / malformed, so
 * the deploy runner's existing build-from-repo → metadata.imageTag →
 * APP_DEFAULT_IMAGE chain is completely unchanged when an operator has not
 * configured the map.
 */
export function makePrebuiltImageMapResolver(
  env: NodeJS.ProcessEnv = process.env,
): AppImageResolver | undefined {
  const raw = env.APP_PREBUILT_IMAGES;
  if (!raw || !raw.trim()) return undefined;

  let entries: Array<[string, string]>;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    entries = Object.entries(parsed).filter(
      (e): e is [string, string] =>
        typeof e[0] === "string" && e[0].length > 0 && typeof e[1] === "string" && e[1].length > 0,
    );
  } catch {
    logger.warn(
      "[AppImageResolver] APP_PREBUILT_IMAGES is not valid JSON; ignoring the per-app prebuilt image map",
    );
    return undefined;
  }
  if (entries.length === 0) return undefined;

  // Longest prefix first → the most specific configured name wins deterministically.
  entries.sort((a, b) => b[0].length - a[0].length);

  return async (app) => {
    for (const [prefix, image] of entries) {
      if (app.name.startsWith(prefix)) {
        // Pin known first-party mutable tags to their digest refs (#13097).
        return pinFirstPartyDigest(image);
      }
    }
    return undefined;
  };
}

/**
 * Compose image resolvers into one; the first to return a non-undefined image
 * wins. Returns `undefined` when no resolver is active (preserving the runner's
 * "no resolveImage configured" path). Used to layer the operator prebuilt-image
 * map behind the build-from-repo resolver.
 */
export function composeImageResolvers(
  ...resolvers: Array<AppImageResolver | undefined>
): AppImageResolver | undefined {
  const active = resolvers.filter((r): r is AppImageResolver => Boolean(r));
  if (active.length === 0) return undefined;
  return async (app) => {
    for (const resolve of active) {
      const image = await resolve(app);
      if (image) return image;
    }
    return undefined;
  };
}

/** A `resolveImage` that builds + pushes the app image from its repo. */
export function makeBuildFromRepoResolver(deps: BuildFromRepoResolverDeps): AppImageResolver {
  return async (app) => {
    const metaRepo = typeof app.metadata?.repoUrl === "string" ? app.metadata.repoUrl : undefined;
    const repo = metaRepo ?? app.repoUrl;
    if (!repo) return undefined;

    const sourceRef = typeof app.metadata?.ref === "string" ? app.metadata.ref : undefined;
    const dockerfile =
      typeof app.metadata?.dockerfile === "string" ? app.metadata.dockerfile : deps.dockerfile;
    const { imageRef } = await deps.builder.build({
      registry: deps.registry,
      appId: app.id,
      context: buildContextFor(repo, sourceRef),
      dockerfile,
      sourceRef,
      // Push so the deploy/worker node can pull the freshly built image.
      push: true,
    });
    // imageRef is the digest-pinned ref (`repo@sha256:<64hex>`) captured
    // atomically from the build invocation (#13097).
    return imageRef;
  };
}
