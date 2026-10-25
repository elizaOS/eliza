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
  /** The resolvable `<registry>/app-<slug>:<tag>` the deploy step runs. */
  imageRef: string;
  /** Raw build output (stdout+stderr), for logs/diagnostics. */
  buildOutput: string;
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
    return { imageRef, buildOutput };
  }
}
