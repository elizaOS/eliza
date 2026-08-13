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
import { shellQuote } from "./docker-sandbox-utils";

/** Command-exec seam — structurally the same as `AppContainerSsh` (reusable). */
export interface BuildExec {
  exec(command: string, timeoutMs?: number): Promise<string>;
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
   * The resolvable image reference the deploy step runs.
   *
   * When the build PUSHED, this is the immutable digest-pinned ref
   * (`<registry>/app-<slug>:<tag>@sha256:<64hex>`) resolved from the registry's
   * pushed manifest via `docker buildx imagetools inspect`. A mutable
   * `<registry>/app-<slug>:<tag>` ref lets the registry swap the bytes behind
   * the name after the deploy-time allowlist check, so the digest pin makes the
   * image content-addressed end-to-end and passes the armed digest-pin gate.
   *
   * When the build did NOT push (local `--load`), the pushed-manifest digest is
   * unavailable, so this is the mutable `<registry>/app-<slug>:<tag>` ref as
   * before — those are trusted/verification builds that don't traverse the
   * registry the gate protects.
   */
  imageRef: string;
  /** Raw build output (stdout+stderr), for logs/diagnostics. */
  buildOutput: string;
}

/**
 * Parse the immutable sha256 digest from `docker buildx imagetools inspect`
 * output. The manifest list / manifest digest is reported on the `Digest:`
 * line, e.g.
 *   Name:      ghcr.io/elizaos/app-xxx:tag
 *   MediaType: application/vnd.oci.image.index.v1+json
 *   Digest:    sha256:2c68b639eec00fad1b35e978f5463f1543b392c96680ec496fd0c0a9eddc8241
 *
 * Returns the FIRST full `sha256:<64 hex>` digest found, preferring the
 * top-level manifest digest over the per-platform child digests. Returns null
 * when no digest is present so the caller can fall back to the mutable ref with
 * a warning instead of failing the whole build.
 */
export function parseImagetoolsDigest(output: string): string | null {
  const match = output.match(/sha256:[0-9a-f]{64}/i);
  return match ? match[0].toLowerCase() : null;
}

/** Assemble the `docker buildx imagetools inspect <ref>` command. */
export function buildImagetoolsInspectCmd(imageRef: string): string {
  return `docker buildx imagetools inspect ${shellQuote(imageRef)}`;
}

export class AppImageBuilder {
  private readonly exec: BuildExec;
  private readonly timeoutMs: number;
  private readonly isolatedBuilder: boolean;

  constructor(deps: { exec: BuildExec; timeoutMs?: number; isolatedBuilder?: boolean }) {
    this.exec = deps.exec;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60_000;
    // Untrusted Dockerfiles run in a throwaway isolated builder by default;
    // opt out only for trusted/verification builds against the host daemon.
    this.isolatedBuilder = deps.isolatedBuilder ?? true;
  }

  /** Build (and optionally push) the app image; returns the resolvable ref. */
  async build(req: AppImageBuildRequest): Promise<AppImageBuildResult> {
    const imageRef = buildAppImageRef({
      registry: req.registry,
      appId: req.appId,
      sourceRef: req.sourceRef,
    });

    let command: string;
    if (this.isolatedBuilder) {
      // Random per-build suffix so two concurrent untrusted builds never share a
      // BuildKit instance; the script tears the builder down on EXIT.
      const builderName = isolatedBuilderName(req.appId, randomBytes(6).toString("hex"));
      command = buildIsolatedAppImageScript({
        context: req.context,
        dockerfile: req.dockerfile,
        imageRef,
        push: req.push,
        buildArgs: req.buildArgs,
        builderName,
      });
    } else {
      command = buildAppImageBuildCmd({
        context: req.context,
        dockerfile: req.dockerfile,
        imageRef,
        push: req.push,
        buildArgs: req.buildArgs,
      });
    }

    const buildOutput = await this.exec.exec(command, this.timeoutMs);

    // When the image was PUSHED, resolve the immutable digest from the registry
    // so the returned ref is content-addressed end-to-end (#13097). The mutable
    // `<registry>/app-<slug>:<tag>` ref the build produced lets the registry
    // swap the bytes behind the name after the deploy-time allowlist check;
    // pinning the pushed manifest digest defeats that. A failed inspect is
    // non-fatal — the build succeeded, so fall back to the mutable ref with a
    // warning rather than throwing away a good build (the digest-pin gate will
    // reject it downstream when armed, which is the correct escalation).
    let resolvedRef = imageRef;
    if (req.push) {
      try {
        const inspectOutput = await this.exec.exec(
          buildImagetoolsInspectCmd(imageRef),
          this.timeoutMs,
        );
        const digest = parseImagetoolsDigest(inspectOutput);
        if (digest) {
          resolvedRef = `${imageRef}@${digest}`;
        }
      } catch {
        // Inspect failed (registry lag, transient auth, offline verification).
        // Keep the mutable ref; the deploy gate handles the mismatch.
      }
    }

    return { imageRef: resolvedRef, buildOutput };
  }
}
