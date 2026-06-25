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

export type AppImageResolverEnv = Pick<NodeJS.ProcessEnv, "APP_PREBUILT_IMAGES">;

function parsePrebuiltImageMap(raw: string | undefined): Array<[prefix: string, image: string]> {
  const trimmed = raw?.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return [];

  return Object.entries(parsed)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].trim().length > 0 && typeof entry[1] === "string" && entry[1].trim().length > 0,
    )
    .map(([prefix, image]) => [prefix.trim(), image.trim()])
    .sort(([a], [b]) => b.length - a.length);
}

/**
 * Operator escape hatch for repo-less showcase apps: map app name prefixes to
 * prebuilt images through APP_PREBUILT_IMAGES. Invalid config intentionally
 * disables this resolver instead of throwing at daemon boot, because imageTag /
 * APP_DEFAULT_IMAGE fallback remains the safer deploy path when the map is bad.
 */
export function makePrebuiltImageMapResolver(
  env: AppImageResolverEnv = process.env,
): AppImageResolver | undefined {
  const entries = parsePrebuiltImageMap(env.APP_PREBUILT_IMAGES);
  if (entries.length === 0) return undefined;

  return (app) => {
    const match = entries.find(([prefix]) => app.name.startsWith(prefix));
    return match?.[1];
  };
}

/**
 * Compose optional image resolvers in priority order. Returning undefined when
 * nothing is active preserves the runner's built-in metadata.imageTag /
 * APP_DEFAULT_IMAGE fallback semantics.
 */
export function composeImageResolvers(
  ...resolvers: Array<AppImageResolver | undefined>
): AppImageResolver | undefined {
  const active = resolvers.filter((resolver): resolver is AppImageResolver => Boolean(resolver));
  if (active.length === 0) return undefined;

  return async (app) => {
    for (const resolver of active) {
      const image = await resolver(app);
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
