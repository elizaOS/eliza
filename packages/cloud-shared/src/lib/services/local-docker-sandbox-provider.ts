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
import nodeCrypto from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { promisify } from "node:util";

import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import {
  allocatePort,
  getContainerName,
  getVolumePath,
  validateAgentId,
  validateAgentName,
  validateContainerName,
  validateEnvKey,
  validateEnvValue,
} from "./docker-sandbox-utils";
import type { SandboxCreateConfig, SandboxHandle, SandboxProvider } from "./sandbox-provider-types";

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
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const HEALTH_WAIT_TOTAL_MS = 60_000;

const LOG_PREFIX = "[LocalDockerSandboxProvider]";

function resolveContainerPort(config: SandboxCreateConfig): string {
  const requested =
    typeof config.environmentVars.PORT === "string" && config.environmentVars.PORT.trim()
      ? config.environmentVars.PORT.trim()
      : typeof config.container?.port === "number"
        ? String(config.container.port)
        : containersEnv.agentPort();
  if (!/^\d+$/.test(requested)) {
    throw new Error(`${LOG_PREFIX} Invalid container port: ${requested}`);
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Typed metadata returned in SandboxHandle.metadata
// ---------------------------------------------------------------------------
export interface LocalDockerSandboxMetadata {
  provider: "local-docker";
  containerName: string;
  containerId: string;
  bridgePort: number;
  healthPort: number;
  agentId: string;
  volumePath: string;
  dockerImage: string;
}

interface ContainerMeta {
  agentId: string;
  containerName: string;
  containerId: string;
  bridgePort: number;
  healthPort: number;
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

    // The canonical cloud-agent image exposes TWO ports:
    //   - "health"/REST API port (default 2138, e.g. /api/health, /api/agents)
    //   - "bridge"/JSON-RPC port (default 18790, /bridge)
    // The provider needs to publish both so the cloud-side
    // elizaSandboxService can hit /api/* via health_url AND /bridge via
    // bridge_url. agentPort = health/api port, agentBridgePort = /bridge.
    const agentPort = resolveContainerPort(config);
    const agentBridgePort = containersEnv.agentBridgePort();
    if (!/^\d+$/.test(agentPort) || !/^\d+$/.test(agentBridgePort)) {
      throw new Error(
        `${LOG_PREFIX} Invalid agent ports: api=${agentPort}, bridge=${agentBridgePort}`,
      );
    }

    // If a container with this name already exists from a prior run, remove it
    // so we can re-create cleanly. Local dev is single-tenant per agentId.
    await this.removeExistingContainer(containerName);

    const bridgePort = this.ports.reserve(LOCAL_BRIDGE_PORT_MIN, LOCAL_BRIDGE_PORT_MAX);
    const healthPort = this.ports.reserve(LOCAL_BRIDGE_PORT_MIN, LOCAL_BRIDGE_PORT_MAX);
    const volumePath = getVolumePath(agentId);

    await this.ensureImagePulled(dockerImage);

    // Rewrite loopback URLs (127.0.0.1 / localhost) in any env value to
    // host.docker.internal so the container can reach host services like the
    // PGlite TCP bridge. Docker Desktop maps this automatically; on Linux
    // the --add-host flag below provides the same binding.
    const rewriteForContainer = (value: string): string =>
      value.replace(/\b(127\.0\.0\.1|localhost)\b/g, "host.docker.internal");
    const rewrittenEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(environmentVars)) {
      rewrittenEnv[k] = rewriteForContainer(v);
    }

    // Drop the cloud's DATABASE_URL — local PGlite TCP bridge can't reliably
    // serve concurrent in-container plugin-sql clients on top of the host
    // wrangler workload, and connection storms cause container-side ECONNs.
    // Without DATABASE_URL the elizaOS plugin-sql cleanly falls back to a
    // per-container bundled PGlite, which is the right default for local dev
    // (each agent gets its own isolated DB).
    delete rewrittenEnv.DATABASE_URL;
    delete rewrittenEnv.POSTGRES_URL;

    // Generate a shared token used for both the cloud-agent /bridge auth
    // (BRIDGE_SECRET) and the elizaOS REST API auth (ELIZA_API_TOKEN). Keeping
    // them the same lets `getAgentJsonHeaders()` on the cloud-api side use a
    // single Authorization header to reach either endpoint.
    const apiToken =
      rewrittenEnv.ELIZA_API_TOKEN ||
      rewrittenEnv.BRIDGE_SECRET ||
      crypto.randomUUID().replace(/-/g, "");

    // Pass through LLM provider keys from the host env so any agent the
    // cloud-api spawns can actually answer. Without these, the elizaOS
    // runtime crashes the container's process on the first message.send
    // (NoModelProviderConfiguredError). Allow per-sandbox overrides via
    // environmentVars to win.
    const hostEnv = process.env;
    const llmPassthrough: Record<string, string> = {};
    for (const key of [
      "ELIZAOS_CLOUD_API_KEY",
      "BITROUTER_API_KEY",
      "BITROUTER_BASE_URL",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "XAI_API_KEY",
      "GROQ_API_KEY",
    ]) {
      const value = hostEnv[key];
      if (typeof value === "string" && value.length > 0 && !rewrittenEnv[key]) {
        llmPassthrough[key] = value;
      }
    }

    const allEnv: Record<string, string> = {
      ...llmPassthrough,
      ...rewrittenEnv,
      AGENT_NAME: agentName,
      AGENT_ID: agentId,
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_PORT: agentPort,
      PORT: agentPort,
      BRIDGE_PORT: agentBridgePort,
      AGENT_API_BIND: "0.0.0.0",
      ELIZA_API_BIND: "0.0.0.0",
      AGENT_DISABLE_AUTO_API_TOKEN: "1",
      ELIZA_DISABLE_AUTO_API_TOKEN: "1",
      JWT_SECRET: rewrittenEnv.JWT_SECRET || crypto.randomUUID(),
      ELIZA_VAULT_PASSPHRASE:
        rewrittenEnv.ELIZA_VAULT_PASSPHRASE || crypto.randomUUID().replace(/-/g, ""),
      ELIZA_API_TOKEN: apiToken,
      BRIDGE_SECRET: apiToken,
      // plugin-sql throws under NODE_ENV=production without a SECRET_SALT.
      // Generate a per-sandbox value so two agents on the same host don't
      // share encrypted-state keys. Stable per agentId so restarts decrypt.
      SECRET_SALT:
        rewrittenEnv.SECRET_SALT ||
        nodeCrypto.createHash("sha256").update(`local-docker-secret-salt:${agentId}`).digest("hex"),
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
      // Make host.docker.internal resolvable on Linux Docker too; on Docker
      // Desktop (Mac/Windows) it's already mapped but this is harmless.
      "--add-host",
      "host.docker.internal:host-gateway",
      // Host bridgePort → container's /bridge JSON-RPC port
      "-p",
      `127.0.0.1:${bridgePort}:${agentBridgePort}`,
      // Host healthPort → container's REST API + /api/health port
      "-p",
      `127.0.0.1:${healthPort}:${agentPort}`,
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
      this.ports.release(healthPort);
      throw new Error(
        `${LOG_PREFIX} docker run failed for ${containerName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const meta: ContainerMeta = {
      agentId,
      containerName,
      containerId,
      bridgePort,
      healthPort,
      volumePath,
      dockerImage,
    };
    this.containers.set(containerName, meta);

    const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
    const healthUrl = `http://127.0.0.1:${healthPort}/api`;
    const metadata: LocalDockerSandboxMetadata = {
      provider: "local-docker",
      containerName,
      containerId,
      bridgePort,
      healthPort,
      agentId,
      volumePath,
      dockerImage,
    };

    logger.info(
      `${LOG_PREFIX} Container ${containerName} (${containerId}) up — bridge=${bridgeUrl} health=${healthUrl}`,
    );

    return {
      sandboxId: containerName,
      bridgeUrl,
      healthUrl,
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
      this.ports.release(meta.healthPort);
      this.containers.delete(sandboxId);
    }
  }

  // ------------------------------------------------------------------
  // checkHealth
  // ------------------------------------------------------------------

  async checkHealth(handle: SandboxHandle): Promise<boolean> {
    // Probe BOTH /api/health (public ghcr.io/elizaos/eliza image) and /health
    // (the bespoke cloud-agent image built from Dockerfile.cloud-agent) on the
    // health port. Either responding 200/401 counts as healthy.
    // Containers can take 10-60s to come up from cold-start; retry-poll for up
    // to ~60s before giving up.
    const origin = new URL(handle.healthUrl).origin;
    const candidates = [`${origin}/api/health`, `${origin}/health`];
    const deadline = Date.now() + HEALTH_WAIT_TOTAL_MS;
    while (Date.now() < deadline) {
      for (const url of candidates) {
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
          if (status === "200" || status === "401") return true;
        } catch (err) {
          logger.debug(
            `${LOG_PREFIX} health probe ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
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
