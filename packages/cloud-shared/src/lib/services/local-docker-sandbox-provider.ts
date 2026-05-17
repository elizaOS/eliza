/**
 * LocalDockerSandboxProvider — SandboxProvider that runs agent containers
 * against the local Docker daemon (Docker Desktop / dockerd on the dev host).
 *
 * Targets local development only. Skips all production sandbox concerns
 * (SSH to remote nodes, Headscale VPN, Steward tenant registration,
 * docker_nodes DB rows). Containers are addressed via 127.0.0.1 with a
 * host-published port in [LOCAL_BRIDGE_PORT_MIN, LOCAL_BRIDGE_PORT_MAX).
 */

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { promisify } from "node:util";

import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import {
  allocatePort,
  getContainerName,
  getVolumePath,
  shellQuote as _shellQuote, // imported for parity; unused — execFile arg arrays avoid shells
  validateAgentId,
  validateAgentName,
  validateContainerName,
  validateEnvKey,
  validateEnvValue,
} from "./docker-sandbox-utils";
import type { SandboxCreateConfig, SandboxHandle, SandboxProvider } from "./sandbox-provider-types";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _suppressUnused = _shellQuote;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Local-only port range — chosen to NOT overlap the remote range (18790-19790)
// or the local web-ui range (20000-25000), per the task spec.
// ---------------------------------------------------------------------------
const LOCAL_BRIDGE_PORT_MIN = 30000;
const LOCAL_BRIDGE_PORT_MAX = 40000;

const DOCKER_BIN = "docker";
const CURL_BIN = "curl";
const LSOF_BIN = "lsof";

const DOCKER_CMD_TIMEOUT_MS = 60_000;
const DOCKER_PULL_TIMEOUT_MS = 300_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

const LOG_PREFIX = "[LocalDockerSandboxProvider]";

// ---------------------------------------------------------------------------
// Typed metadata returned in SandboxHandle.metadata
// ---------------------------------------------------------------------------
export interface LocalDockerSandboxMetadata {
  provider: "local-docker";
  containerName: string;
  containerId: string;
  bridgePort: number;
  agentId: string;
  volumePath: string;
  dockerImage: string;
}

interface ContainerMeta {
  agentId: string;
  containerName: string;
  containerId: string;
  bridgePort: number;
  volumePath: string;
  dockerImage: string;
}

// ---------------------------------------------------------------------------
// Port allocator with in-memory tracking + lsof-backed liveness fallback.
// ---------------------------------------------------------------------------
class LocalPortAllocator {
  private readonly used = new Map<number, boolean>();

  reserve(min: number, max: number): number {
    // Build exclusion set from in-memory map first.
    const excluded = new Set<number>();
    for (const [port, taken] of this.used) {
      if (taken) excluded.add(port);
    }

    // Try a handful of allocations, falling back to lsof to confirm liveness
    // when the in-memory map says the port is free.
    const MAX_ATTEMPTS = 32;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = allocatePort(min, max, excluded);
      if (this.isPortLive(candidate)) {
        excluded.add(candidate);
        continue;
      }
      this.used.set(candidate, true);
      return candidate;
    }
    throw new Error(
      `${LOG_PREFIX} Failed to allocate a free port in [${min},${max}) after ${MAX_ATTEMPTS} attempts.`,
    );
  }

  release(port: number): void {
    this.used.delete(port);
  }

  /** Returns true if `lsof` reports something listening on the port. */
  private isPortLive(port: number): boolean {
    try {
      // execFileSync would block on shell startup; spawnSync via require is
      // also OK but we keep this synchronous + simple via child_process.
      // We use spawnSync indirectly through Bun's worker; fall back to false
      // if the binary is missing.
      const result = bunSpawnSync(LSOF_BIN, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
      return result.exitCode === 0 && result.stdout.trim().length > 0;
    } catch {
      // If lsof isn't available, trust the in-memory map.
      return false;
    }
  }
}

interface SyncSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Tiny sync spawn wrapper. Avoids a top-level import of node:child_process's
 * spawnSync to keep the imports tidy and so Bun's polyfill is used uniformly.
 */
function bunSpawnSync(bin: string, args: string[]): SyncSpawnResult {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync(bin, args, { encoding: "utf-8" });
  return {
    exitCode: typeof r.status === "number" ? r.status : 1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

// ---------------------------------------------------------------------------
// LocalDockerSandboxProvider
// ---------------------------------------------------------------------------
export class LocalDockerSandboxProvider implements SandboxProvider {
  private readonly containers = new Map<string, ContainerMeta>();
  private readonly ports = new LocalPortAllocator();
  private readonly pulledImages = new Set<string>();

  // ------------------------------------------------------------------
  // create
  // ------------------------------------------------------------------

  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const { agentId, agentName, environmentVars } = config;

    validateAgentId(agentId);
    validateAgentName(agentName);

    const containerName = getContainerName(agentId);
    validateContainerName(containerName);

    const dockerImage = config.dockerImage ?? containersEnv.defaultAgentImage();
    validateDockerImageRef(dockerImage);

    const agentPort = containersEnv.agentPort();
    if (!/^\d+$/.test(agentPort)) {
      throw new Error(`${LOG_PREFIX} Invalid ELIZA_AGENT_PORT "${agentPort}": must be numeric.`);
    }

    // If a container with this name already exists from a prior run, remove it
    // so we can re-create cleanly. Local dev is single-tenant per agentId.
    await this.removeExistingContainer(containerName);

    const bridgePort = this.ports.reserve(LOCAL_BRIDGE_PORT_MIN, LOCAL_BRIDGE_PORT_MAX);
    const volumePath = getVolumePath(agentId);

    await this.ensureImagePulled(dockerImage);

    const allEnv: Record<string, string> = {
      ...environmentVars,
      AGENT_NAME: agentName,
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_PORT: agentPort,
      PORT: agentPort,
      AGENT_API_BIND: "0.0.0.0",
      ELIZA_API_BIND: "0.0.0.0",
      AGENT_DISABLE_AUTO_API_TOKEN: "1",
      ELIZA_DISABLE_AUTO_API_TOKEN: "1",
      JWT_SECRET: environmentVars.JWT_SECRET || crypto.randomUUID(),
      ELIZA_VAULT_PASSPHRASE: environmentVars.ELIZA_VAULT_PASSPHRASE || crypto.randomUUID(),
    };

    for (const [key, value] of Object.entries(allEnv)) {
      validateEnvKey(key);
      validateEnvValue(key, value);
    }

    const dockerArgs: string[] = [
      "run",
      "-d",
      "--name",
      containerName,
      "--restart",
      "unless-stopped",
      "-p",
      `127.0.0.1:${bridgePort}:${agentPort}`,
    ];

    for (const [key, value] of Object.entries(allEnv)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    dockerArgs.push(dockerImage);

    logger.info(`${LOG_PREFIX} Starting container ${containerName} on host port ${bridgePort}`);

    let containerId: string;
    try {
      const { stdout } = await execFileAsync(DOCKER_BIN, dockerArgs, {
        timeout: DOCKER_CMD_TIMEOUT_MS,
      });
      containerId = stdout.trim().slice(0, 12);
      if (!/^[0-9a-f]{12}$/i.test(containerId)) {
        throw new Error(
          `docker run returned unexpected output: ${JSON.stringify(stdout.slice(0, 200))}`,
        );
      }
    } catch (err) {
      this.ports.release(bridgePort);
      throw new Error(
        `${LOG_PREFIX} docker run failed for ${containerName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const meta: ContainerMeta = {
      agentId,
      containerName,
      containerId,
      bridgePort,
      volumePath,
      dockerImage,
    };
    this.containers.set(containerName, meta);

    const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
    const metadata: LocalDockerSandboxMetadata = {
      provider: "local-docker",
      containerName,
      containerId,
      bridgePort,
      agentId,
      volumePath,
      dockerImage,
    };

    logger.info(`${LOG_PREFIX} Container ${containerName} (${containerId}) up at ${bridgeUrl}`);

    return {
      sandboxId: containerName,
      bridgeUrl,
      healthUrl: `${bridgeUrl}/api`,
      metadata: { ...metadata },
    };
  }

  // ------------------------------------------------------------------
  // stop
  // ------------------------------------------------------------------

  async stop(sandboxId: string): Promise<void> {
    validateContainerName(sandboxId);
    const meta = this.containers.get(sandboxId);

    logger.info(`${LOG_PREFIX} Stopping container ${sandboxId}`);

    await this.execDocker(["stop", "-t", "10", sandboxId]).catch((err: unknown) => {
      logger.warn(
        `${LOG_PREFIX} docker stop failed for ${sandboxId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    await this.execDocker(["rm", "-f", sandboxId]).catch((err: unknown) => {
      logger.warn(
        `${LOG_PREFIX} docker rm failed for ${sandboxId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    if (meta) {
      this.ports.release(meta.bridgePort);
      this.containers.delete(sandboxId);
    }
  }

  // ------------------------------------------------------------------
  // checkHealth
  // ------------------------------------------------------------------

  async checkHealth(handle: SandboxHandle): Promise<boolean> {
    const url = `${handle.bridgeUrl.replace(/\/$/, "")}/api/health`;
    try {
      const { stdout } = await execFileAsync(
        CURL_BIN,
        [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          String(Math.max(1, Math.floor(HEALTH_CHECK_TIMEOUT_MS / 1000))),
          url,
        ],
        { timeout: HEALTH_CHECK_TIMEOUT_MS },
      );
      const status = stdout.trim();
      return status === "200" || status === "401";
    } catch (err) {
      logger.debug(
        `${LOG_PREFIX} health check failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // ------------------------------------------------------------------
  // runCommand — docker exec
  // ------------------------------------------------------------------

  async runCommand(sandboxId: string, cmd: string, args?: string[]): Promise<string> {
    validateContainerName(sandboxId);
    const fullArgs = ["exec", sandboxId, cmd, ...(args ?? [])];
    const { stdout } = await execFileAsync(DOCKER_BIN, fullArgs, {
      timeout: DOCKER_CMD_TIMEOUT_MS,
    });
    return stdout;
  }

  // ------------------------------------------------------------------
  // Convenience methods (not on SandboxProvider, but mentioned in the spec)
  // ------------------------------------------------------------------

  /** `docker logs --tail <lines> <containerId|name>` */
  async getLogs(handle: SandboxHandle, lines = 200): Promise<string> {
    validateContainerName(handle.sandboxId);
    if (!Number.isInteger(lines) || lines <= 0 || lines > 100_000) {
      throw new Error(`${LOG_PREFIX} Invalid lines value: ${lines}`);
    }
    const { stdout } = await execFileAsync(
      DOCKER_BIN,
      ["logs", "--tail", String(lines), handle.sandboxId],
      { timeout: DOCKER_CMD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  }

  /** Fully delete the agent: stop + rm + remove host volume directory. */
  async deleteAgent(handle: SandboxHandle): Promise<void> {
    await this.stop(handle.sandboxId);
    const meta = handle.metadata as Partial<LocalDockerSandboxMetadata> | undefined;
    const volumePath = meta?.volumePath;
    if (typeof volumePath === "string" && volumePath.startsWith("/") && existsSync(volumePath)) {
      try {
        rmSync(volumePath, { recursive: true, force: true });
        logger.info(`${LOG_PREFIX} Removed volume directory ${volumePath}`);
      } catch (err) {
        logger.warn(
          `${LOG_PREFIX} Failed to remove volume directory ${volumePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Proxy a JSON-RPC POST to the container's bridge endpoint.
   * Mirrors the production bridge but speaks plain HTTP — no Steward proxy.
   */
  async bridge(handle: SandboxHandle, body: unknown): Promise<Response> {
    const url = `${handle.bridgeUrl.replace(/\/$/, "")}/bridge`;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  /**
   * Streaming bridge — same as `bridge` but passes the response body through
   * unbuffered (SSE pass-through is the caller's responsibility).
   */
  async bridgeStream(handle: SandboxHandle, body: unknown): Promise<Response> {
    const url = `${handle.bridgeUrl.replace(/\/$/, "")}/bridge`;
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async ensureImagePulled(image: string): Promise<void> {
    if (this.pulledImages.has(image)) return;

    // Check whether the image already exists locally; if so, skip the pull.
    try {
      const { stdout } = await execFileAsync(
        DOCKER_BIN,
        ["image", "inspect", "--format", "{{.Id}}", image],
        { timeout: DOCKER_CMD_TIMEOUT_MS },
      );
      if (stdout.trim().length > 0) {
        this.pulledImages.add(image);
        return;
      }
    } catch {
      // not present — fall through to pull
    }

    logger.info(`${LOG_PREFIX} Pulling image ${image} (this may take a while)…`);
    try {
      await execFileAsync(DOCKER_BIN, ["pull", image], { timeout: DOCKER_PULL_TIMEOUT_MS });
      this.pulledImages.add(image);
      logger.info(`${LOG_PREFIX} Pulled image ${image}`);
    } catch (err) {
      throw new Error(
        `${LOG_PREFIX} docker pull ${image} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async removeExistingContainer(containerName: string): Promise<void> {
    try {
      await execFileAsync(DOCKER_BIN, ["rm", "-f", containerName], {
        timeout: DOCKER_CMD_TIMEOUT_MS,
      });
      logger.info(`${LOG_PREFIX} Removed pre-existing container ${containerName}`);
    } catch {
      // No-op: container most likely didn't exist.
    }
  }

  private async execDocker(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(DOCKER_BIN, args, { timeout: DOCKER_CMD_TIMEOUT_MS });
    return stdout;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a Docker image reference well enough to be safely passed to
 * `docker run`. Restricts to the printable subset of OCI reference syntax
 * (registry/repo[:tag][@digest]).
 */
function validateDockerImageRef(image: string): void {
  if (!image || image.length > 512) {
    throw new Error(`${LOG_PREFIX} Invalid Docker image ref length.`);
  }
  if (!/^[A-Za-z0-9._/:@-]+$/.test(image)) {
    throw new Error(`${LOG_PREFIX} Invalid Docker image ref "${image}".`);
  }
}
