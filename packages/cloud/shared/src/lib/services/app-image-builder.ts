/**
 * AppImageBuilder (Apps / Product 2) — the impure build executor for the
 * repo→image pipeline. Composes the pure ref/command builders
 * ({@link buildAppImageRef}, {@link buildIsolatedAppImageScript}) and runs them
 * over an injected `exec` seam: SSH to a builder host in production, a local
 * shell in verification. The ONLY IO is `exec`, so the orchestration is
 * unit-testable with a fake and the same code path is exercised locally against
 * real Docker.
 *
 * SECURITY: the Dockerfile is UNTRUSTED (user-supplied). By default the build is
 * run inside a FRESH, THROWAWAY `docker-container` BuildKit instance that is torn
 * down after the build (see {@link buildIsolatedAppImageScript}), so an untrusted
 * build never shares cache/state with the host daemon hosting tenant containers.
 * The builder name carries random entropy so concurrent builds never collide on
 * a shared BuildKit. Set `isolatedBuilder: false` only for trusted/verification
 * builds where the host daemon is acceptable.
 *
 * IMMUTABLE IMAGES (#13097): the build pushes under a mutable tag, but the
 * result ref returned to the deploy runner is DIGEST-PINNED
 * (`repo@sha256:<64hex>`). The digest is captured from the SAME build
 * invocation via buildx `--metadata-file` — never re-resolved by tag
 * afterwards. A concurrent build or a registry retag between push and a
 * `docker buildx imagetools inspect` lookup could return a wrong digest;
 * `--metadata-file` is atomic and immune to that race. Missing or invalid
 * digest → {@link BuildMetadataError} (fail fast, never silently fall back to
 * the mutable tag).
 *
 * Decoupled from the deploy/run path: the builder yields a resolvable image ref;
 * `app-deploy-runner.ts` resolves that ref and the container provider runs it.
 */

import { randomBytes } from "node:crypto";
import {
  buildAppImageBuildCmd,
  buildIsolatedAppImageScript,
  isolatedBuilderName,
} from "./app-build-cmd";
import { buildAppImageRef } from "./app-image-ref";
import { BuildMetadataError, buildDigestPinnedRef, parseBuildxDigest } from "./build-metadata";

/** Command-exec seam — structurally the same as `AppContainerSsh` (reusable). */
export interface BuildExec {
  exec(command: string, timeoutMs?: number): Promise<string>;
}

/** A second seam for reading the buildx metadata-file back from the build host. */
export interface MetadataReader {
  read(path: string): Promise<string>;
}

export interface AppImageBuildRequest {
  /** Registry + namespace the image is tagged/pushed under. */
  registry: string;
  appId: string;
  /** Git sha/branch built from (→ image tag); omitted → `latest`. */
  sourceRef?: string;
  /** Build context: local dir path or git URL. */
  context: string;
  /** Dockerfile path relative to the context. */
  dockerfile?: string;
  /** Push to the registry after build; else the image stays on the build host. */
  push?: boolean;
  /** Non-secret build args (baked into image history — never secrets). */
  buildArgs?: Record<string, string>;
}

export interface AppImageBuildResult {
  /**
   * The resolvable image ref for the deploy step. When the build pushes and the
   * digest is captured, this is `<repo>@sha256:<64hex>` (content-addressed).
   * When the build does NOT push (local only), this is the mutable tag ref — a
   * non-pushed image has no registry digest to pin, so the digest gate stays
   * off for verification/local builds.
   */
  imageRef: string;
  /** The mutable tag ref the image was pushed under (for logs/diagnostics). */
  tagRef: string;
  /** The captured sha256 digest, when available. */
  digest?: string;
  /** Raw build output (stdout+stderr), for logs/diagnostics. */
  buildOutput: string;
}

export class AppImageBuilder {
  private readonly exec: BuildExec;
  private readonly metadataReader: MetadataReader | undefined;
  private readonly timeoutMs: number;
  private readonly isolatedBuilder: boolean;

  constructor(deps: {
    exec: BuildExec;
    /** Reads the buildx metadata-file from the build host. Required for digest capture. */
    metadataReader?: MetadataReader;
    timeoutMs?: number;
    isolatedBuilder?: boolean;
  }) {
    this.exec = deps.exec;
    this.metadataReader = deps.metadataReader;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60_000;
    // Untrusted Dockerfiles run in a throwaway isolated builder by default;
    // opt out only for trusted/verification builds against the host daemon.
    this.isolatedBuilder = deps.isolatedBuilder ?? true;
  }

  /**
   * Build (and optionally push) the app image; returns the digest-pinned ref
   * when the build pushes, or the mutable tag ref for non-pushed local builds.
   *
   * Throws {@link BuildMetadataError} when the build pushes but the digest
   * cannot be captured atomically — fail fast rather than silently returning a
   * mutable tag (#13097).
   */
  async build(req: AppImageBuildRequest): Promise<AppImageBuildResult> {
    const tagRef = buildAppImageRef({
      registry: req.registry,
      appId: req.appId,
      sourceRef: req.sourceRef,
    });

    // When pushing, capture the digest atomically via --metadata-file so the
    // returned ref is content-addressed. A non-pushed local build has no
    // registry digest, so no metadata-file is needed.
    const push = req.push ?? false;
    const metadataFile =
      push && this.metadataReader
        ? `/tmp/buildx-metadata-${randomBytes(6).toString("hex")}.json`
        : undefined;

    let command: string;
    if (this.isolatedBuilder) {
      // Random per-build suffix so two concurrent untrusted builds never share a
      // BuildKit instance; the script tears the builder down on EXIT.
      const builderName = isolatedBuilderName(req.appId, randomBytes(6).toString("hex"));
      command = buildIsolatedAppImageScript({
        context: req.context,
        dockerfile: req.dockerfile,
        imageRef: tagRef,
        push: req.push,
        buildArgs: req.buildArgs,
        builderName,
        metadataFile,
      });
    } else {
      command = buildAppImageBuildCmd({
        context: req.context,
        dockerfile: req.dockerfile,
        imageRef: tagRef,
        push: req.push,
        buildArgs: req.buildArgs,
        metadataFile,
      });
    }

    const buildOutput = await this.exec.exec(command, this.timeoutMs);

    // Non-pushed build: return the mutable tag ref — no registry digest exists.
    if (!push) {
      return { imageRef: tagRef, tagRef, buildOutput };
    }

    // Pushed build: the digest MUST be captured atomically. Fail fast if the
    // metadata reader wasn't injected or the file is missing/invalid — never
    // silently return the mutable tag (#13097).
    if (!this.metadataReader || !metadataFile) {
      throw new BuildMetadataError(
        `Build pushed ${tagRef} but no metadata reader is configured — cannot capture the atomic digest. ` +
          `Inject a MetadataReader into AppImageBuilder to enable immutable image refs.`,
      );
    }

    let rawMetadata: string;
    try {
      rawMetadata = await this.metadataReader.read(metadataFile);
    } catch (cause) {
      throw new BuildMetadataError(
        `Failed to read buildx metadata-file at ${metadataFile} after pushing ${tagRef} — ` +
          `the digest was not captured from this build invocation`,
        { cause },
      );
    }

    const digest = parseBuildxDigest(rawMetadata);
    const imageRef = buildDigestPinnedRef(tagRef, digest);
    return { imageRef, tagRef, digest, buildOutput };
  }
}
