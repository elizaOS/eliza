/**
 * Sandbox subsystem barrel + mode-selection seam.
 *
 * This module is the single dispatch site for picking between the host
 * (`yolo`) execution path and a sandboxed (`sandbox`) execution path. Nothing
 * downstream branches on `mode`; callers receive a `Driver` and use it.
 *
 *   - `createSandboxDriver(opts)` constructs a `SandboxDriver` wired to the
 *     requested backend (`docker` or `qemu`). Throws
 *     `SandboxBackendUnavailableError` if the backend cannot be constructed.
 *   - `getCurrentDriver(runtime)` consults `ComputerUseService.getConfig()`
 *     and returns either the host driver shim or a sandbox driver. This is
 *     the canonical mode-selection seam; if you find yourself writing
 *     `if (mode === 'sandbox')` somewhere, route through this instead.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ComputerUseService } from "../services/computer-use-service.js";
import {
  type ComputerUseMode,
  type SandboxBackendName,
  type SandboxBackendOptions,
  type SandboxConfig,
} from "../types.js";
import { DockerBackend, type DockerBackendOptions } from "./docker-backend.js";
import { QemuBackend } from "./qemu-backend.js";
import { SandboxDriver } from "./sandbox-driver.js";
import {
  SandboxBackendUnavailableError,
  type Driver,
  type SandboxBackend,
} from "./types.js";

export interface CreateSandboxDriverOptions {
  backend: SandboxBackendName;
  image: string;
  options?: SandboxBackendOptions;
  /**
   * Test-only hook: inject a pre-built backend instead of constructing one.
   * Production callers do not pass this.
   */
  backendOverride?: SandboxBackend;
  /** Test-only Docker constructor overrides. */
  dockerOverrides?: Pick<
    DockerBackendOptions,
    "spawnExec" | "runShell" | "dockerBinary"
  >;
}

/**
 * Construct a `SandboxDriver` for the requested backend. The driver is not
 * started here — `SandboxDriver` lazily boots on first op so callers don't
 * pay for a container start until they actually need one.
 */
export function createSandboxDriver(
  opts: CreateSandboxDriverOptions,
): SandboxDriver {
  if (opts.backendOverride) {
    return new SandboxDriver(opts.backendOverride);
  }

  if (opts.backend === "docker") {
    const backend = new DockerBackend({
      image: opts.image,
      env: opts.options?.env,
      ...(opts.dockerOverrides ?? {}),
    });
    return new SandboxDriver(backend);
  }

  if (opts.backend === "qemu") {
    // QemuBackend's constructor throws SandboxBackendUnavailableError until
    // Phase 2. Surfacing the throw here keeps the mode-selection seam loud.
    const backend = new QemuBackend({ image: opts.image });
    return new SandboxDriver(backend);
  }

  throw new SandboxBackendUnavailableError(
    `Unknown sandbox backend: ${String(opts.backend)}`,
    String(opts.backend),
  );
}

/**
 * Mode-selection seam. Returns either the host driver (yolo) or a sandbox
 * driver (sandbox). Called by the dispatch layer; never branched on by
 * callers.
 *
 * NOTE: when `mode === 'yolo'` we currently return `null`. The host
 * `Driver`-shaped wrapper around `platform/driver.ts` lands in the same
 * series as the rest of the dispatch refactor; the existing
 * `ComputerUseService` calls into `platform/driver.ts` directly. Treat
 * `null` as "use the legacy in-service host path".
 */
export function getCurrentDriver(runtime: IAgentRuntime): Driver | null {
  const service = runtime.getService<ComputerUseService>(
    ComputerUseService.serviceType,
  );
  if (!service) return null;
  const config = service.getConfig();
  if (config.mode === "yolo") return null;
  if (!config.sandbox) {
    throw new SandboxBackendUnavailableError(
      "ELIZA_COMPUTERUSE_MODE=sandbox but no sandbox config resolved. " +
        "Set ELIZA_COMPUTERUSE_SANDBOX_BACKEND and ELIZA_COMPUTERUSE_SANDBOX_IMAGE.",
      "unknown",
    );
  }
  return createSandboxDriver({
    backend: config.sandbox.backend,
    image: config.sandbox.image,
    options: config.sandbox.options,
  });
}

/** Resolve the `ComputerUseMode` from raw env input. Exported for testing. */
export function resolveModeFromEnv(
  raw: string | undefined,
): ComputerUseMode {
  if (raw === "sandbox") return "sandbox";
  return "yolo";
}

export { DockerBackend } from "./docker-backend.js";
export type { DockerBackendOptions } from "./docker-backend.js";
export { QemuBackend } from "./qemu-backend.js";
export type { QemuBackendOptions } from "./qemu-backend.js";
export { SandboxDriver } from "./sandbox-driver.js";
export {
  SandboxBackendUnavailableError,
  SandboxInvocationError,
  type Driver,
  type SandboxBackend,
  type SandboxOp,
  type ScrollDirection,
} from "./types.js";
export type {
  FileActionResult,
  ProcessInfoLite,
  ScreenRegion,
  TerminalActionResult,
  WindowInfo,
} from "./surface-types.js";
export type { SandboxConfig };
