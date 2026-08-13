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
 */

import { ElizaError } from "@elizaos/core";
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
 * Returns `undefined` when the env is unset or empty. Malformed maps fail fast
 * so an operator cannot unknowingly fall through to another image source.
 */
export function parsePrebuiltImageMap(raw: string): Array<[string, string]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // error-policy:J3 operator configuration is untrusted input; reject malformed
    // JSON explicitly instead of degrading to an absent map.
    throw new ElizaError("APP_PREBUILT_IMAGES must be valid JSON", {
      code: "APPS_PREBUILT_IMAGES_INVALID",
      cause: error,
      severity: "fatal",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ElizaError("APP_PREBUILT_IMAGES must be a JSON object", {
      code: "APPS_PREBUILT_IMAGES_INVALID",
      severity: "fatal",
    });
  }

  const entries = Object.entries(parsed);
  for (const [prefix, image] of entries) {
    if (!prefix.trim() || typeof image !== "string" || !image.trim()) {
      throw new ElizaError(
        "APP_PREBUILT_IMAGES keys and image references must be non-empty strings",
        {
          code: "APPS_PREBUILT_IMAGES_INVALID",
          context: { prefix },
          severity: "fatal",
        },
      );
    }
  }
  return entries as Array<[string, string]>;
}

export function makePrebuiltImageMapResolver(
  env: NodeJS.ProcessEnv = process.env,
): AppImageResolver | undefined {
  const raw = env.APP_PREBUILT_IMAGES;
  if (!raw || !raw.trim()) return undefined;

  const entries = parsePrebuiltImageMap(raw);
  if (entries.length === 0) return undefined;

  // Longest prefix first → the most specific configured name wins deterministically.
  entries.sort((a, b) => b[0].length - a[0].length);

  return async (app) => {
    for (const [prefix, image] of entries) {
      if (app.name.startsWith(prefix)) return image;
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
    return imageRef;
  };
}
