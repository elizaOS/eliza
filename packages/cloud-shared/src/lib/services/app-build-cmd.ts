/**
 * Pure `docker build` command assembly for the Apps / Product 2 build pipeline.
 *
 * Turns a build request (source context, optional Dockerfile, image ref, build
 * args) into the exact `docker build` / `docker buildx build` command the
 * (impure) build executor runs over SSH on a builder node — or locally in
 * verification. Pure string assembly, so the build invocation is a unit-testable
 * contract, mirroring app-docker-cmd.ts.
 *
 * The source context is either a local dir path OR a git URL — docker builds git
 * contexts natively (`docker build https://host/repo.git#ref:subdir`), so the
 * common "build from the user's repo" path needs no separate clone step.
 *
 * SECURITY: only NON-secret values belong in `buildArgs` (they're baked into the
 * image history). Secrets must be injected at RUN time via the per-tenant
 * `environmentVars` (see app-docker-cmd.ts), never here.
 */

import { shellQuote } from "./docker-sandbox-utils";

export interface AppBuildCmdParams {
  /** Build context: a local dir path or a git URL (optionally `#ref:subdir`). */
  context: string;
  /** Dockerfile path relative to the context. Default: docker's `Dockerfile`. */
  dockerfile?: string;
  /** Full image reference to tag the build with (see buildAppImageRef). */
  imageRef: string;
  /** Push to the registry after build (requires buildx) vs load locally. */
  push?: boolean;
  /** Non-secret build args. */
  buildArgs?: Record<string, string>;
  /**
   * Force `docker buildx build`. Implied by `push`. When false (and not
   * pushing), uses plain `docker build` (the image lands in the local daemon).
   */
  buildx?: boolean;
}

/** Assemble the docker build command for a user app image. */
export function buildAppImageBuildCmd(params: AppBuildCmdParams): string {
  const useBuildx = params.buildx ?? Boolean(params.push);
  const parts: string[] = [useBuildx ? "docker buildx build" : "docker build"];

  parts.push(`--tag ${shellQuote(params.imageRef)}`);
  if (params.dockerfile) {
    parts.push(`--file ${shellQuote(params.dockerfile)}`);
  }
  for (const [key, value] of Object.entries(params.buildArgs ?? {})) {
    parts.push(`--build-arg ${shellQuote(`${key}=${value}`)}`);
  }

  if (params.push) {
    parts.push("--push");
  } else if (useBuildx) {
    // buildx doesn't load into the local daemon by default; --load does.
    parts.push("--load");
  }

  parts.push(shellQuote(params.context));
  return parts.join(" ");
}

/** The `docker push <ref>` command, when build + push are separate steps. */
export function buildAppImagePushCmd(imageRef: string): string {
  return `docker push ${shellQuote(imageRef)}`;
}
