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
 *
 * SECURITY (build isolation): the build runs an UNTRUSTED user Dockerfile. With
 * the default `docker` buildx driver the build executes against the host's
 * shared dockerd — the same daemon hosting other tenants' live containers — so a
 * malicious Dockerfile (RUN steps reaching the docker socket, cache poisoning,
 * daemon API access) can compromise co-tenants or the node. {@link isolatedBuilder}
 * pins the build to a FRESH, THROWAWAY `docker-container` BuildKit instance whose
 * BuildKit runs in its own container (no host build cache, no daemon image store
 * write on `--push`), created before the build and torn down after — so an
 * untrusted build never shares state with the runtime daemon. See
 * {@link buildIsolatedAppImageScript}.
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
  /**
   * Name of a buildx builder instance to pin the build to (`--builder <name>`).
   * Set by {@link buildIsolatedAppImageScript} to a fresh throwaway builder;
   * implies buildx. Omit for the plain host-daemon build.
   */
  builderName?: string;
  /** Pass `--no-cache` (untrusted builds skip any shared cache). */
  noCache?: boolean;
}

/** Assemble the docker build command for a user app image. */
export function buildAppImageBuildCmd(params: AppBuildCmdParams): string {
  const useBuildx = params.buildx ?? Boolean(params.push ?? params.builderName);
  const parts: string[] = [useBuildx ? "docker buildx build" : "docker build"];

  if (params.builderName) {
    parts.push(`--builder ${shellQuote(params.builderName)}`);
  }
  parts.push(`--tag ${shellQuote(params.imageRef)}`);
  if (params.dockerfile) {
    parts.push(`--file ${shellQuote(params.dockerfile)}`);
  }
  if (params.noCache) {
    parts.push("--no-cache");
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

/** A DNS/Docker-safe, unique-per-build name for a throwaway buildx builder. */
export function isolatedBuilderName(appId: string, suffix: string): string {
  const appSlug = appId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const safeSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `apps-build-${appSlug.slice(0, 12)}-${safeSuffix.slice(0, 12)}`;
}

export interface IsolatedAppBuildScriptParams extends Omit<AppBuildCmdParams, "builderName"> {
  /**
   * Unique name for the throwaway builder (see {@link isolatedBuilderName}).
   * Must be unique per concurrent build so two builds never share a BuildKit.
   */
  builderName: string;
}

/**
 * Assemble a single shell script that runs an UNTRUSTED build in a FRESH,
 * THROWAWAY, isolated buildx builder and guarantees teardown afterwards.
 *
 * The script:
 *   1. `docker buildx create --driver docker-container --name <builder>` — a
 *      one-shot BuildKit running in its OWN container, isolated from the host
 *      daemon's build cache and image store; `set -e` so a create failure aborts
 *      before any build runs.
 *   2. `trap '... buildx rm' EXIT` — the builder is ALWAYS removed (success,
 *      failure, or signal), so untrusted BuildKit state never lingers on the
 *      node and builders don't accumulate.
 *   3. the `docker buildx build --builder <builder> --push ...` itself.
 *
 * `--push` writes straight to the registry from inside the isolated BuildKit, so
 * even on push the untrusted image is never loaded into the host daemon's image
 * store. The build context (a git URL or dir) and all build args are
 * shell-quoted by {@link buildAppImageBuildCmd}; the builder name is quoted here.
 *
 * NOTE: `docker-container` is rootless-friendly but still needs a dockerd to
 * launch the BuildKit container. For full root-isolation from the runtime fleet,
 * that dockerd should be a DEDICATED builder host (no tenant containers) —
 * selected by the executor (see container-executor-deps `selectBuilderHost`).
 * This script provides the in-daemon throwaway-builder seam; the dedicated host
 * is the infra complement.
 */
export function buildIsolatedAppImageScript(params: IsolatedAppBuildScriptParams): string {
  const builder = shellQuote(params.builderName);
  const buildCmd = buildAppImageBuildCmd({ ...params, buildx: true, noCache: params.noCache });
  return [
    "set -e",
    `docker buildx create --driver docker-container --name ${builder} --bootstrap >/dev/null`,
    `trap 'docker buildx rm --force ${builder} >/dev/null 2>&1 || true' EXIT`,
    buildCmd,
  ].join("\n");
}

/** The `docker push <ref>` command, when build + push are separate steps. */
export function buildAppImagePushCmd(imageRef: string): string {
  return `docker push ${shellQuote(imageRef)}`;
}
