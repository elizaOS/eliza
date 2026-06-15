/**
 * Build-from-repo image resolver (Apps / Product 2) — connects the build
 * pipeline to the deploy runner. Returns a `resolveImage` (the shape
 * `AppDeployRunner` calls) that BUILDS the app's image from its git repo via
 * {@link AppImageBuilder} and returns the pushed, resolvable ref.
 *
 * Returns `undefined` when the app has no repo, so the deploy runner falls
 * through to `app.metadata.imageTag` / `APP_DEFAULT_IMAGE` (e.g. a prebuilt or
 * smoke-test image) — never an error for the no-repo case.
 *
 * Docker builds git URLs natively (`docker build <git-url>#ref:subdir`), so the
 * repo URL is passed straight through as the build context — no clone step.
 */

import type { AppImageBuilder } from "./app-image-builder";

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

/** A `resolveImage` that builds + pushes the app image from its repo. */
export function makeBuildFromRepoResolver(
  deps: BuildFromRepoResolverDeps,
): (app: ResolverApp) => Promise<string | undefined> {
  return async (app) => {
    const metaRepo = typeof app.metadata?.repoUrl === "string" ? app.metadata.repoUrl : undefined;
    const repo = app.repoUrl ?? metaRepo;
    if (!repo) return undefined;

    const sourceRef = typeof app.metadata?.ref === "string" ? app.metadata.ref : undefined;
    const { imageRef } = await deps.builder.build({
      registry: deps.registry,
      appId: app.id,
      context: repo,
      dockerfile: deps.dockerfile,
      sourceRef,
      // Push so the deploy/worker node can pull the freshly built image.
      push: true,
    });
    return imageRef;
  };
}
