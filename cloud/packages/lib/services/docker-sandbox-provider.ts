/**
 * DockerSandboxProvider — SandboxProvider implementation for Docker containers
 * on remote VPS nodes.
 *
 * Manages the full lifecycle: create (pull image + docker run), stop/remove,
 * health-check, and arbitrary command execution inside containers.
 *
 * Reference: eliza-cloud/backend/services/container-orchestrator.ts
 */

import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import { containersEnv } from "@/lib/config/containers-env";
import { getAgentBaseDomain } from "@/lib/eliza-agent-web-ui";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { dockerNodeManager } from "@/lib/services/docker-node-manager";
import { getUsedDockerHostPorts } from "@/lib/services/docker-port-allocation";
import { DockerSSHClient } from "@/lib/services/docker-ssh";
import { resolveStewardTenantCredentials } from "@/lib/services/steward-tenant-config";
import { resolveServerStewardApiUrlFromEnv } from "@/lib/steward-url";
import { logger } from "@/lib/utils/logger";
import {
  allocatePort,
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  extractDockerCreateContainerId,
  getContainerName,
  getVolumePath,
  parseDockerNodes,
  requiresDockerHostGateway,
  resolveStewardContainerUrl,
  shellQuote,
  validateAgentId,
  validateAgentName,
  validateEnvKey,
  validateEnvValue,
  WEBUI_PORT_MAX,
  WEBUI_PORT_MIN,
} from "./docker-sandbox-utils";
import { headscaleIntegration } from "./headscale-integration";
import type { SandboxCreateConfig, SandboxHandle, SandboxProvider } from "./sandbox-provider-types";

// ---------------------------------------------------------------------------
// Exported metadata type for strongly-typed provider metadata
// ---------------------------------------------------------------------------

/** Typed metadata returned by DockerSandboxProvider in SandboxHandle.metadata */
export interface DockerSandboxMetadata {
  provider: "docker";
  nodeId: string;
  hostname: string;
  containerName: string;
  bridgePort: number;
  webUiPort: number;
  agentId: string;
  volumePath: string;
  dockerImage: string;
  headscaleIp?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ContainerMeta {
  nodeId: string;
  hostname: string;
  containerName: string;
  bridgePort: number;
  webUiPort: number;
  agentId: string;
  sshPort: number;
  sshUser: string;
  hostKeyFingerprint?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOCKER_IMAGE = containersEnv.defaultAgentImage();
const DOCKER_NETWORK = containersEnv.dockerNetwork();
let hasWarnedMissingStewardTenantApiKey = false;

const DEFAULT_LEGACY_PORT = containersEnv.legacyContainerPort();
const DEFAULT_AGENT_PORT = containersEnv.agentPort();
const DEFAULT_BRIDGE_PORT = containersEnv.agentBridgePort();

/** Default SSH port when not specified by DB node record. */
const DEFAULT_SSH_PORT = 22;

/** Default SSH user when not specified by DB node record. */
const DEFAULT_SSH_USERNAME = containersEnv.sshUser();

function resolveStewardHostUrl(): string {
  return resolveServerStewardApiUrlFromEnv(getCloudAwareEnv());
}

function resolveStewardContainerEnvUrl(): string {
  const env = getCloudAwareEnv();
  return resolveStewardContainerUrl(resolveStewardHostUrl(), env.STEWARD_CONTAINER_URL);
}

/**
 * When USE_STEWARD_PROXY=true, route LLM and EVM RPC calls through the
 * Steward proxy reachable from the container at host.docker.internal:8080
 * (the proxy listens on the docker host). Returns an empty object when
 * proxy mode is disabled so callers can spread it unconditionally.
 */
export function buildStewardProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.USE_STEWARD_PROXY !== "true") return {};
  const base = "http://host.docker.internal:8080";
  return {
    STEWARD_PROXY_URL: base,
    OPENAI_BASE_URL: `${base}/openai/v1`,
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    BSC_RPC_URL: "https://bsc-dataseed.binance.org",
    BASE_RPC_URL: "https://mainnet.base.org",
    ETHEREUM_RPC_URL: "https://eth.llamarpc.com",
  };
}

/** Health-check polling: interval between retries (ms). */
const HEALTH_CHECK_POLL_INTERVAL_MS = 3_000;

/** Health-check polling: total timeout (ms). */
const HEALTH_CHECK_TIMEOUT_MS = 180_000;

/** SSH command timeout for docker pull (can be slow on first pull). */
const PULL_TIMEOUT_MS = 300_000; // 5 min

/** SSH command timeout for docker run / stop / rm. */
const DOCKER_CMD_TIMEOUT_MS = 60_000;

function getDockerHealthCmd(port: string): string {
  if (!/^\d+$/.test(port)) {
    throw new Error(`[docker-sandbox] Invalid port "${port}": must be a numeric string.`);
  }
  // /api/health returns 200 or 401 (auth required) — both mean the server is up.
  // Use curl with -o /dev/null and check status code to accept either.
  return `sh -lc 'STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}/api/health" 2>/dev/null); [ "$STATUS" = "200" ] || [ "$STATUS" = "401" ]'`;
}

function extractStewardToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("[docker-sandbox] Steward token endpoint returned an empty response");
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    // Steward API may return { token: "..." } or { data: { token: "..." } }.
    // Keep one fallback for agentToken in case an older Steward build uses
    // that field name.
    const candidate =
      parsed.token ??
      parsed.agentToken ??
      (typeof parsed.data === "object" && parsed.data !== null
        ? (parsed.data as Record<string, unknown>).token
        : undefined);

    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  } catch {
    // Some Steward builds may return the token as plain text.
  }

  // Sanity check: reject responses that look like HTML error pages or are
  // unreasonably long (e.g. a full HTML document instead of a token).
  if (trimmed.length > 2048) {
    throw new Error(
      "[docker-sandbox] Steward token response exceeds 2048 chars — likely not a valid token",
    );
  }
  if (trimmed.includes("<") || trimmed.includes(">")) {
    throw new Error(
      "[docker-sandbox] Steward token response contains HTML markers — likely an error page",
    );
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      "[docker-sandbox] Steward token response contains whitespace — likely not a valid token",
    );
  }

  logger.warn(
    "[docker-sandbox] Steward token response was plain text instead of JSON; accepting legacy fallback",
  );
  return trimmed;
}

function warnMissingStewardTenantApiKey(apiKey?: string) {
  if (apiKey || hasWarnedMissingStewardTenantApiKey) {
    return;
  }

  hasWarnedMissingStewardTenantApiKey = true;
  logger.warn(
    "[docker-sandbox] STEWARD_TENANT_API_KEY is not set; Steward registration will run without tenant API key auth",
  );
}

async function registerAgentWithSteward(
  ssh: DockerSSHClient,
  agentId: string,
  agentName: string,
  tenantId: string,
  apiKey?: string,
): Promise<string> {
  warnMissingStewardTenantApiKey(apiKey);

  const script = `python3 - <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url = ${JSON.stringify(resolveStewardHostUrl())}
api_key = ${JSON.stringify(apiKey ?? "")}
tenant_id = ${JSON.stringify(tenantId)}
agent_id = ${JSON.stringify(agentId)}
agent_name = ${JSON.stringify(agentName)}


def post(path, payload):
    headers = {"Content-Type": "application/json"}
    if tenant_id:
        headers["X-Steward-Tenant"] = tenant_id
    if api_key:
        headers["X-Steward-Key"] = api_key
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


status, body = post("/agents", {"id": agent_id, "name": agent_name})
if status not in (200, 201, 202, 400, 409):
    print(body, file=sys.stderr)
    raise SystemExit(f"Steward agent registration failed with status {status}")
# 400/409 = agent already exists, continue to token minting

status, body = post(f"/agents/{agent_id}/token", {"expiresIn": "365d"})
if status not in (200, 201):
    print(body, file=sys.stderr)
    raise SystemExit(f"Steward token mint failed with status {status}")

print(body)
PY`;

  const rawToken = await ssh.exec(script, DOCKER_CMD_TIMEOUT_MS);
  return extractStewardToken(rawToken);
}

// ---------------------------------------------------------------------------
// DockerSandboxProvider
// ---------------------------------------------------------------------------

export class DockerSandboxProvider implements SandboxProvider {
  /**
   * In-memory container metadata cache.
   * On Workers/serverless this cache is per-request and starts empty — the DB
   * fallback in resolveContainer() handles rehydration. In long-lived processes
   * (Docker self-hosting) it persists across requests.
   */
  private containers = new Map<string, ContainerMeta>();

  // ------------------------------------------------------------------
  // create
  // ------------------------------------------------------------------

  /**
   * Create a sandbox container with automatic retry on port-collision TOCTOU races.
   *
   * Wraps {@link _createOnce} in a retry loop (up to 3 attempts with jitter).
   * On each attempt, fresh ports are allocated. If a prior attempt left a
   * ghost container running, it is cleaned up before retrying.
   *
   * NOTE: The DB INSERT (in agent-sandbox.ts) happens *after* this method
   * returns. If that INSERT hits a UNIQUE constraint violation (PG 23505),
   * the caller should call `stop(sandboxId)` to remove the ghost container
   * and then retry the full flow.
   */
  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const MAX_ATTEMPTS = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this._createOnce(config);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isPortCollision =
          lastError.message.includes("23505") ||
          lastError.message.includes("unique constraint") ||
          lastError.message.includes("already in use") ||
          lastError.message.includes("port is already allocated");

        if (!isPortCollision || attempt === MAX_ATTEMPTS) {
          throw lastError;
        }

        // Clean up ghost container from the failed attempt
        const containerName = getContainerName(config.agentId);
        logger.warn(
          `[docker-sandbox] Port collision on attempt ${attempt}/${MAX_ATTEMPTS} for ${containerName}, cleaning up and retrying...`,
        );
        try {
          // sandboxId === containerName for Docker provider (both are `agent-${agentId}`)
          await this.stop(containerName);
        } catch {
          // Ghost may not exist or already be gone — safe to ignore
        }

        // Jitter: 200–800ms to desynchronise concurrent callers
        const jitterMs = 200 + Math.floor(Math.random() * 600);
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
      }
    }

    // Unreachable, but satisfies the compiler
    throw lastError ?? new Error("[docker-sandbox] create exhausted all retry attempts");
  }

  /**
   * Create a single sandbox container (no retry).
   *
   * TOCTOU note: Port allocation is racy under concurrent provisioning.
   * The DB has a partial UNIQUE index on (node_id, bridge_port) for active
   * sandboxes, so a duplicate will fail at INSERT time. The public `create()`
   * method wraps this in a retry loop to handle port collisions automatically.
   */
  private async _createOnce(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const { agentId, agentName, environmentVars, organizationId } = config;

    // Resolve Docker image: explicit config > env var > hardcoded default
    // DOCKER_IMAGE (from env) takes precedence over per-agent DB override.
    // This prevents stale images from being sticky after the env is updated.
    const resolvedImage = DOCKER_IMAGE || config.dockerImage || "ghcr.io/elizaos/eliza:latest";

    // 1. Input validation
    validateAgentName(agentName);
    validateAgentId(agentId);

    // 2. Select target node via DockerNodeManager (least-loaded, DB-backed).
    // getAvailableNode + incrementAllocated + getUsedDockerHostPorts are three sequential
    // DB round-trips without a transaction boundary; the UNIQUE port index and
    // retry logic provide safety against concurrent capacity changes.
    const dbNode = await dockerNodeManager.getAvailableNode();

    let nodeId: string;
    let hostname: string;
    let sshPort = DEFAULT_SSH_PORT;
    let sshUser = DEFAULT_SSH_USERNAME;

    // host_key_fingerprint from DB node (null for env-var fallback, TOFU applies)
    let hostKeyFingerprint: string | undefined;

    if (dbNode) {
      nodeId = dbNode.node_id;
      hostname = dbNode.hostname;
      sshPort = dbNode.ssh_port ?? DEFAULT_SSH_PORT;
      sshUser = dbNode.ssh_user ?? DEFAULT_SSH_USERNAME;
      hostKeyFingerprint = dbNode.host_key_fingerprint ?? undefined;
      // Increment allocated_count in DB
      await dockerNodesRepository.incrementAllocated(nodeId);
    } else {
      // Fallback: seed-only path for initial setup before nodes are registered via Admin API.
      // Uses random selection (no least-loaded placement or capacity checks).
      // Operators should register nodes via POST /admin/docker-nodes for production use.
      logger.warn(
        "[docker-sandbox] No nodes in DB, falling back to CONTAINERS_DOCKER_NODES env var (seed-only, no load balancing)",
      );
      const envNodes = parseDockerNodes();
      const envNode = envNodes[Math.floor(Math.random() * envNodes.length)]!;
      nodeId = envNode.nodeId;
      hostname = envNode.hostname;
      // Env-var nodes use defaults for SSH port/user — log a warning since
      // host key fingerprint is unavailable (TOFU applies)
      logger.warn(
        `[docker-sandbox] Env-var fallback node ${nodeId}: using SSH defaults (port ${sshPort}, user ${sshUser}, no fingerprint)`,
      );
    }

    logger.info(
      `[docker-sandbox] Creating container for agent ${agentId} on node ${nodeId} (${hostname})`,
    );

    // 3. Allocate ports (check DB for existing assignments to avoid collisions)
    const usedPorts = await getUsedDockerHostPorts(nodeId);
    const bridgePort = allocatePort(BRIDGE_PORT_MIN, BRIDGE_PORT_MAX, usedPorts);
    // No need to add bridgePort to exclusion set — web UI port range [20000,25000)
    // never overlaps bridge range [18790,19790)
    const webUiPort = allocatePort(WEBUI_PORT_MIN, WEBUI_PORT_MAX, usedPorts);
    const containerName = getContainerName(agentId);
    const volumePath = getVolumePath(agentId);
    const stewardTenant = await resolveStewardTenantCredentials({ organizationId });

    // 4. Optionally prepare Headscale VPN
    const headscaleEnabled = !!process.env.HEADSCALE_API_KEY;
    let headscaleIp: string | null = null;

    // Collect VPN env vars separately to avoid mutating the caller's environmentVars
    let vpnEnvVars: Record<string, string> = {};
    if (headscaleEnabled) {
      try {
        const vpnSetup = await headscaleIntegration.prepareContainerVPN(agentId);
        vpnEnvVars = vpnSetup.envVars;
        logger.info(`[docker-sandbox] Headscale VPN enabled for ${agentId}`);
      } catch (err) {
        logger.warn(
          `[docker-sandbox] Headscale VPN preparation failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Continue without VPN — not a critical failure
      }
    }

    // 5. Build the base environment (spread to avoid mutating caller's environmentVars)
    const stewardContainerUrl = resolveStewardContainerEnvUrl();
    const proxyEnv = buildStewardProxyEnv();
    const baseEnv: Record<string, string> = {
      ...environmentVars,
      ...vpnEnvVars,
      ...proxyEnv,
      AGENT_NAME: agentName,
      ELIZA_CLOUD_PROVISIONED: "1",
      STEWARD_API_URL: stewardContainerUrl,
      STEWARD_AGENT_ID: agentId,
      // The current cloud agent image listens on PORT (default 2139).
      // Keep ELIZA_PORT for compatibility, but publish/probe the external
      // host ports against PORT so new containers don't expose a dead 2138.
      ELIZA_PORT: DEFAULT_LEGACY_PORT,
      PORT: DEFAULT_AGENT_PORT,
      BRIDGE_PORT: DEFAULT_BRIDGE_PORT,
      // Eliza server requires JWT_SECRET in production mode.
      // Generate a unique per-container secret if the caller didn't provide one.
      JWT_SECRET: environmentVars.JWT_SECRET || crypto.randomUUID(),
      // Allow the agent subdomain origin so the browser can call the API.
      ELIZA_ALLOWED_ORIGINS: `https://${agentId}.${getAgentBaseDomain()}`,
    };

    // 6. SSH to node, ensure volume dir, pull image, register in Steward,
    // then create/start the container. Pass hostKeyFingerprint so pooled
    // clients pin the key when available.
    const ssh = DockerSSHClient.getClient(hostname, sshPort, hostKeyFingerprint, sshUser);

    try {
      // Ensure volume directory exists
      await ssh.exec(`mkdir -p ${shellQuote(volumePath)}`, DOCKER_CMD_TIMEOUT_MS);

      // Pull image (may take a while on first run)
      logger.info(`[docker-sandbox] Pulling image ${resolvedImage} on ${nodeId}`);
      try {
        await ssh.exec(`docker pull ${shellQuote(resolvedImage)}`, PULL_TIMEOUT_MS);
        logger.info(`[docker-sandbox] Image pulled successfully on ${nodeId}`);
      } catch (pullErr) {
        logger.warn(
          `[docker-sandbox] Image pull failed on ${nodeId} (will use cached): ${pullErr instanceof Error ? pullErr.message : String(pullErr)}`,
        );
      }

      logger.info(
        `[docker-sandbox] Registering ${agentId} with Steward tenant ${stewardTenant.tenantId} on ${nodeId}`,
      );
      const stewardAgentToken = await registerAgentWithSteward(
        ssh,
        agentId,
        agentName,
        stewardTenant.tenantId,
        stewardTenant.apiKey,
      );

      const allEnv: Record<string, string> = {
        ...baseEnv,
        STEWARD_AGENT_TOKEN: stewardAgentToken,
        // Bind to 0.0.0.0 so Docker port mapping works (container otherwise
        // listens on 127.0.0.1 which is unreachable via -p host:container).
        // Set BOTH AGENT_API_BIND and ELIZA_API_BIND — the image default for
        // AGENT_API_BIND is 127.0.0.1 (loopback-only) which would make the
        // bridge port unreachable from outside the container.
        AGENT_API_BIND: "0.0.0.0",
        ELIZA_API_BIND: "0.0.0.0",
        // Prevent the server from auto-generating a RANDOM API token when bound
        // to 0.0.0.0.  The DB-provisioned ELIZA_API_TOKEN (set in baseEnv by
        // managed-agent-env.ts) is the canonical inbound auth token — the pair
        // flow hands it to the browser so the web UI can authenticate.  Clearing
        // it here caused isAuthorized() to reject every request on cloud-
        // provisioned containers (no token + cloud flag = 401).
        AGENT_DISABLE_AUTO_API_TOKEN: "1",
        ELIZA_DISABLE_AUTO_API_TOKEN: "1",
      };

      // Validate env keys/values before they are interpolated into remote shell commands.
      // Internal env vars must also remain UPPER_SNAKE_CASE so validation stays
      // consistent across caller-supplied and provider-generated values.
      for (const [key, value] of Object.entries(allEnv)) {
        validateEnvKey(key);
        validateEnvValue(key, value);
      }

      const envFlags = Object.entries(allEnv)
        .map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`)
        .join(" ");

      const dockerCreateCmd = [
        "docker create",
        `--name ${shellQuote(containerName)}`,
        "--restart unless-stopped",
        `--network ${shellQuote(DOCKER_NETWORK)}`,
        ...(requiresDockerHostGateway(stewardContainerUrl) || Object.keys(proxyEnv).length > 0
          ? ["--add-host host.docker.internal:host-gateway"]
          : []),
        `--health-cmd ${shellQuote(getDockerHealthCmd(allEnv.PORT || DEFAULT_AGENT_PORT))}`,
        "--health-interval 10s",
        "--health-timeout 5s",
        "--health-start-period 15s",
        "--health-retries 6",
        ...(headscaleEnabled ? ["--cap-add=NET_ADMIN", "--device /dev/net/tun"] : []),
        `-v ${shellQuote(volumePath)}:/app/data`,
        // The cloud image serves both API and web UI from PORT (default 2139).
        // Publish both externally allocated host ports to that live listener so
        // nginx can reach /api/* via bridge_url and the UI via web_ui_port.
        `-p ${bridgePort}:${allEnv.PORT || DEFAULT_AGENT_PORT}`,
        `-p ${webUiPort}:${allEnv.PORT || DEFAULT_AGENT_PORT}`,
        envFlags,
        shellQuote(resolvedImage),
      ].join(" ");

      const containerId = extractDockerCreateContainerId(
        await ssh.exec(dockerCreateCmd, DOCKER_CMD_TIMEOUT_MS),
      );
      await ssh.exec(`docker start ${shellQuote(containerName)}`, DOCKER_CMD_TIMEOUT_MS);
      logger.info(
        `[docker-sandbox] Container created on ${nodeId}: ${containerId} (${containerName})`,
      );
    } catch (err) {
      // Best-effort Steward deregistration — the agent was registered but the
      // container failed to start, so we try to clean up the Steward record.
      try {
        await ssh.exec(
          `curl -s -X DELETE -H ${shellQuote(`X-Steward-Tenant: ${stewardTenant.tenantId}`)} ${stewardTenant.apiKey ? `-H ${shellQuote(`X-Steward-Key: ${stewardTenant.apiKey}`)}` : ""} ${shellQuote(`${resolveStewardHostUrl()}/agents/${agentId}`)} || true`,
          DOCKER_CMD_TIMEOUT_MS,
        );
        logger.info(`[docker-sandbox] Cleaned up Steward agent ${agentId} after container failure`);
      } catch (cleanupErr) {
        logger.warn(
          `[docker-sandbox] Failed to cleanup Steward agent ${agentId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }

      await ssh
        .exec(`docker rm -f ${shellQuote(containerName)}`, DOCKER_CMD_TIMEOUT_MS)
        .catch(() => {});

      // Rollback allocated_count on failure
      if (dbNode) {
        await dockerNodesRepository.decrementAllocated(nodeId).catch(() => {});
      }
      // Clean up Headscale pre-auth key if VPN was prepared
      if (headscaleEnabled) {
        await headscaleIntegration.cleanupContainerVPN(agentId).catch((cleanupErr) => {
          logger.warn(
            `[docker-sandbox] Headscale cleanup failed during rollback for ${agentId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        });
      }
      throw new Error(
        `[docker-sandbox] Failed to create container on ${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 8. Wait for Headscale VPN registration if enabled
    if (headscaleEnabled) {
      try {
        headscaleIp = await headscaleIntegration.waitForVPNRegistration(agentId, 60_000);
        if (headscaleIp) {
          logger.info(
            `[docker-sandbox] Container ${containerName} registered on VPN: ${headscaleIp}`,
          );
        } else {
          logger.warn(
            `[docker-sandbox] VPN registration timeout for ${containerName}, continuing without VPN`,
          );
        }
      } catch (err) {
        logger.warn(
          `[docker-sandbox] VPN registration failed for ${containerName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 9. Store metadata in in-memory cache (includes SSH details for stop/runCommand)
    const meta: ContainerMeta = {
      nodeId,
      hostname,
      containerName,
      bridgePort,
      webUiPort,
      agentId,
      sshPort,
      sshUser,
      hostKeyFingerprint,
    };
    this.containers.set(containerName, meta);

    // 10. Return handle with strongly-typed metadata
    const targetHost = headscaleIp || hostname;

    const metadata: DockerSandboxMetadata = {
      provider: "docker",
      nodeId,
      hostname,
      containerName,
      bridgePort,
      webUiPort,
      agentId,
      volumePath,
      dockerImage: resolvedImage,
      headscaleIp: headscaleIp || undefined,
    };

    return {
      sandboxId: containerName,
      bridgeUrl: `http://${targetHost}:${bridgePort}`,
      healthUrl: `http://${targetHost}:${webUiPort}/api`,
      metadata: metadata as unknown as Record<string, unknown>,
    };
  }

  // ------------------------------------------------------------------
  // stop
  // ------------------------------------------------------------------

  async stop(sandboxId: string): Promise<void> {
    const meta = await this.resolveContainer(sandboxId);

    logger.info(
      `[docker-sandbox] Stopping container ${meta.containerName} on ${meta.nodeId} (${meta.hostname})`,
    );

    const ssh = DockerSSHClient.getClient(
      meta.hostname,
      meta.sshPort,
      meta.hostKeyFingerprint,
      meta.sshUser,
    );

    try {
      // Graceful stop with 10s timeout, then force-remove
      await ssh.exec(`docker stop -t 10 ${shellQuote(meta.containerName)}`, DOCKER_CMD_TIMEOUT_MS);
      logger.info(`[docker-sandbox] Container stopped: ${meta.containerName}`);
    } catch (stopErr) {
      logger.warn(
        `[docker-sandbox] docker stop failed for ${meta.containerName}: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
      );
    }

    try {
      await ssh.exec(`docker rm -f ${shellQuote(meta.containerName)}`, DOCKER_CMD_TIMEOUT_MS);
      logger.info(`[docker-sandbox] Container removed: ${meta.containerName}`);
    } catch (rmErr) {
      logger.error(
        `[docker-sandbox] docker rm failed for ${meta.containerName}: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
      );
    }

    // Decrement allocated_count on the node
    await dockerNodesRepository.decrementAllocated(meta.nodeId).catch((err) => {
      logger.warn(
        `[docker-sandbox] Failed to decrement allocated_count for node ${meta.nodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Clean up Headscale VPN registration if enabled
    if (process.env.HEADSCALE_API_KEY && meta.agentId) {
      await headscaleIntegration.cleanupContainerVPN(meta.agentId).catch((err) => {
        logger.warn(
          `[docker-sandbox] Headscale cleanup failed for ${meta.agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    // Remove from in-memory registry
    this.containers.delete(meta.containerName);
  }

  // ------------------------------------------------------------------
  // checkHealth
  // ------------------------------------------------------------------

  async checkHealth(handle: SandboxHandle): Promise<boolean> {
    const meta = await this.resolveContainer(handle.sandboxId);
    const ssh = DockerSSHClient.getClient(
      meta.hostname,
      meta.sshPort,
      meta.hostKeyFingerprint,
      meta.sshUser,
    );
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
    const inspectCmd = `docker inspect --format '{{.State.Health.Status}}' ${shellQuote(meta.containerName)}`;

    logger.info(
      `[docker-sandbox] Polling Docker health for ${meta.containerName} on ${meta.nodeId} (${meta.hostname}) (timeout: ${HEALTH_CHECK_TIMEOUT_MS / 1000}s)`,
    );

    while (Date.now() < deadline) {
      try {
        const status = (
          await ssh.exec(inspectCmd, Math.min(10_000, HEALTH_CHECK_TIMEOUT_MS))
        ).trim();

        if (status === "healthy") {
          logger.info(
            `[docker-sandbox] Docker health check passed for ${meta.containerName}: ${status}`,
          );
          return true;
        }

        logger.debug(
          `[docker-sandbox] Docker health for ${meta.containerName} is ${status || "unknown"}, retrying...`,
        );
      } catch (err) {
        logger.debug(
          `[docker-sandbox] Docker health inspect failed for ${meta.containerName}, retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Wait before retrying (but don't overshoot the deadline)
      const remaining = deadline - Date.now();
      if (remaining > HEALTH_CHECK_POLL_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL_MS));
      } else if (remaining > 0) {
        // One last attempt after a short wait
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000)));
      } else {
        break;
      }
    }

    logger.warn(
      `[docker-sandbox] Docker health check timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000}s for ${meta.containerName} on ${meta.hostname}`,
    );
    return false;
  }

  // ------------------------------------------------------------------
  // runCommand
  // ------------------------------------------------------------------

  async runCommand(sandboxId: string, cmd: string, args?: string[]): Promise<string> {
    const meta = await this.resolveContainer(sandboxId);

    // Shell-escape each argument to prevent command injection
    const escapedArgs = args && args.length > 0 ? args.map((a) => shellQuote(a)).join(" ") : "";
    const fullCmd = escapedArgs ? `${shellQuote(cmd)} ${escapedArgs}` : shellQuote(cmd);

    logger.info(
      `[docker-sandbox] Executing command in ${meta.containerName}: ${cmd} ${(args ?? []).join(" ").slice(0, 80)}`,
    );

    const ssh = DockerSSHClient.getClient(
      meta.hostname,
      meta.sshPort,
      meta.hostKeyFingerprint,
      meta.sshUser,
    );
    const output = await ssh.exec(
      `docker exec ${shellQuote(meta.containerName)} ${fullCmd}`,
      DOCKER_CMD_TIMEOUT_MS,
    );

    return output;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Resolve a sandboxId to its container metadata.
   *
   * Lookup order:
   * 1. In-memory registry (fast path, avoids DB call)
   * 2. Database lookup (hydrates from persisted docker metadata)
   * 3. Last resort: env-var fallback with first node (for backwards compat)
   */
  private async resolveContainer(sandboxId: string): Promise<ContainerMeta> {
    // Fast path: already tracked in memory
    const tracked = this.containers.get(sandboxId);
    if (tracked) return tracked;

    // DB lookup: hydrate from persisted metadata after restart
    try {
      const sandbox = await agentSandboxesRepository.findBySandboxId(sandboxId);
      if (sandbox && sandbox.node_id && sandbox.container_name) {
        // Find hostname + SSH config from DB node record or env var
        let hostname = "";
        let sshPort = DEFAULT_SSH_PORT;
        let sshUser = DEFAULT_SSH_USERNAME;
        let hostKeyFingerprint: string | undefined;

        const dbNode = await dockerNodesRepository.findByNodeId(sandbox.node_id);
        if (dbNode) {
          hostname = dbNode.hostname;
          sshPort = dbNode.ssh_port ?? DEFAULT_SSH_PORT;
          sshUser = dbNode.ssh_user ?? DEFAULT_SSH_USERNAME;
          hostKeyFingerprint = dbNode.host_key_fingerprint ?? undefined;
        } else {
          throw new Error(
            `[docker-sandbox] Missing persisted docker node metadata for node "${sandbox.node_id}"`,
          );
        }

        if (hostname) {
          const bridgePort = sandbox.bridge_port ?? 0;
          const webUiPort = sandbox.web_ui_port ?? 0;
          if (!bridgePort || !webUiPort) {
            logger.warn(
              `[docker-sandbox] Missing port data for "${sandboxId}": bridge=${bridgePort}, webUi=${webUiPort}`,
            );
          }

          const meta: ContainerMeta = {
            nodeId: sandbox.node_id,
            hostname,
            containerName: sandbox.container_name,
            bridgePort,
            webUiPort,
            agentId: sandbox.id, // sandbox.id IS the agent ID (PK = agent identifier throughout the system)
            sshPort,
            sshUser,
            hostKeyFingerprint,
          };

          // Cache key is sandboxId which equals containerName (set in create() return value)
          this.containers.set(sandboxId, meta);
          logger.info(
            `[docker-sandbox] Hydrated container "${sandboxId}" from DB → node ${meta.nodeId} (${meta.hostname})`,
          );
          return meta;
        }
      }
    } catch (err) {
      logger.warn(
        `[docker-sandbox] DB lookup failed for container "${sandboxId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Last resort: container not found
    throw new Error(
      `[docker-sandbox] Container "${sandboxId}" not found in memory or DB. Cannot resolve target node.`,
    );
  }
}
