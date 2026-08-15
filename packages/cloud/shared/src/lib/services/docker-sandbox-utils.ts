/**
 * Docker Sandbox Utilities
 *
 * Pure utility functions extracted from DockerSandboxProvider for reusability
 * and testability. These functions handle shell quoting, validation, port
 * allocation, and node configuration parsing.
 */

import { ElizaError } from "@elizaos/core";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DockerNodeEnv {
  nodeId: string;
  hostname: string;
  capacity: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BRIDGE_PORT_MIN = 18790;
export const BRIDGE_PORT_MAX = 19790;
export const WEBUI_PORT_MIN = 20000;
export const WEBUI_PORT_MAX = 25000;
export const DOCKER_CONTAINER_NAME_MAX_LENGTH = 128;
export const AGENT_CONTAINER_NAME_PREFIX = "agent-";
export const MAX_AGENT_ID_LENGTH =
  DOCKER_CONTAINER_NAME_MAX_LENGTH - AGENT_CONTAINER_NAME_PREFIX.length;

export type DockerNodeArchitecture = "amd64" | "arm64";

// ---------------------------------------------------------------------------
// Container labels (test-vs-user marking + safe cleanup targeting)
// ---------------------------------------------------------------------------

/**
 * Every provisioner-created container carries these labels so fleet tooling
 * can distinguish REAL user agents from pool/test containers and from
 * unmanaged debris (hand-run containers, CI leftovers) without consulting the
 * DB. The disk-clean cycle's container prune excludes anything carrying
 * `CONTAINER_LABEL_MANAGED_BY` — a stopped user agent container must never be
 * reaped as a cleanup side effect (deleting it forces a full re-provision on
 * next start, the churn class behind #15228/#15398).
 */
export const CONTAINER_LABEL_MANAGED_BY = "ai.elizaos.managed-by";
export const CONTAINER_LABEL_MANAGED_BY_VALUE = "eliza-cloud";
export const CONTAINER_LABEL_AGENT_ID = "ai.elizaos.agent-id";
export const CONTAINER_LABEL_ORG_ID = "ai.elizaos.org-id";
export const CONTAINER_LABEL_CLASS = "ai.elizaos.container-class";

/**
 * user — a real user's agent; must never be deleted by cleanup tooling.
 * pool — a warm-pool entry owned by the sentinel pool org; reaped by the
 *        pool manager only.
 * test — created by a known test/QA org (containersEnv.testOrgIds()); CI and
 *        fleet janitors may reap these freely.
 */
export type AgentContainerClass = "user" | "pool" | "test";

export function resolveAgentContainerClass(
  organizationId: string,
  options: { warmPoolOrgId: string; testOrgIds: readonly string[] },
): AgentContainerClass {
  if (organizationId === options.warmPoolOrgId) return "pool";
  if (options.testOrgIds.includes(organizationId)) return "test";
  return "user";
}

/** Label key/value pairs shared by the remote and local docker providers. */
export function buildAgentContainerLabelArgs(options: {
  agentId: string;
  organizationId: string;
  containerClass: AgentContainerClass;
}): Array<[string, string]> {
  return [
    [CONTAINER_LABEL_MANAGED_BY, CONTAINER_LABEL_MANAGED_BY_VALUE],
    [CONTAINER_LABEL_AGENT_ID, options.agentId],
    [CONTAINER_LABEL_ORG_ID, options.organizationId],
    [CONTAINER_LABEL_CLASS, options.containerClass],
  ];
}

/**
 * `--label` flags for the remote `docker create` command string (pre-quoted).
 * The arg-array variant for local docker spawns is
 * `buildAgentContainerLabelArgs`.
 */
export function buildAgentContainerLabelFlags(options: {
  agentId: string;
  organizationId: string;
  containerClass: AgentContainerClass;
}): string[] {
  return buildAgentContainerLabelArgs(options).map(
    ([key, value]) => `--label ${shellQuote(`${key}=${value}`)}`,
  );
}

// ---------------------------------------------------------------------------
// Shell Quoting
// ---------------------------------------------------------------------------

/**
 * Shell-escape a single value by wrapping in single-quotes and escaping
 * embedded single-quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Idempotent, race-safe shell command that guarantees the shared agent bridge
 * network exists on a node before a container is attached to it.
 *
 * `node-bootstrap.ts` creates this network in cloud-init, but only for nodes
 * provisioned through the Hetzner Cloud autoscaler. Hetzner Robot cores (and
 * any node whose network was removed out-of-band) never run that bootstrap, so
 * `docker create --network <net>` fails with an opaque "network <net> not
 * found" and the provision retries forever. Running this first lets the
 * provisioner self-heal that drift.
 *
 * The final `inspect` covers the create-create race when two provisions land on
 * the same node simultaneously: the loser's `create` fails ("already exists"),
 * then the re-`inspect` confirms the winner's network and the command still
 * exits 0.
 */
export function buildEnsureNetworkCmd(network: string): string {
  const net = shellQuote(network);
  return `docker network inspect ${net} >/dev/null 2>&1 || docker network create --driver bridge ${net} >/dev/null 2>&1 || docker network inspect ${net} >/dev/null`;
}

// ---------------------------------------------------------------------------
// Platform / Architecture helpers
// ---------------------------------------------------------------------------

export function validateDockerPlatform(platform: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(platform)) {
    throw new Error(
      `Invalid Docker platform "${platform}": must contain only letters, numbers, dots, underscores, slashes, or hyphens.`,
    );
  }
}

export function normalizeDockerArchitecture(
  value: string | undefined | null,
): DockerNodeArchitecture | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["amd64", "x86", "x86_64", "x86-64", "x64"].includes(normalized)) return "amd64";
  if (["arm", "arm64", "aarch64", "arm64/v8"].includes(normalized)) return "arm64";
  return null;
}

export function requiredArchitectureForPlatform(
  platform: string | undefined | null,
): DockerNodeArchitecture | null {
  const normalized = platform?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("amd64") || normalized.includes("x86_64")) return "amd64";
  if (normalized.includes("arm64") || normalized.includes("aarch64")) return "arm64";
  return null;
}

export function inferArchitectureFromHetznerServerType(
  serverType: string | undefined | null,
): DockerNodeArchitecture | null {
  const normalized = serverType?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("cax")) return "arm64";
  if (normalized.startsWith("cx") || normalized.startsWith("cpx") || normalized.startsWith("ccx")) {
    return "amd64";
  }
  return null;
}

export function inferNodeArchitectureFromMetadata(
  metadata: unknown,
): DockerNodeArchitecture | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const explicit =
    typeof record.architecture === "string"
      ? normalizeDockerArchitecture(record.architecture)
      : null;
  if (explicit) return explicit;
  return typeof record.serverType === "string"
    ? inferArchitectureFromHetznerServerType(record.serverType)
    : null;
}

export function isArchitectureCompatibleWithPlatform(
  architecture: DockerNodeArchitecture | null,
  platform: string | undefined | null,
): boolean {
  const required = requiredArchitectureForPlatform(platform);
  return !required || !architecture || architecture === required;
}

export function dockerPlatformFlag(platform: string | undefined | null): string[] {
  const trimmed = platform?.trim();
  if (!trimmed) return [];
  validateDockerPlatform(trimmed);
  return [`--platform ${shellQuote(trimmed)}`];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function hasControlChars(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

/**
 * Validate an agent ID before using it in Docker-derived names and shell commands.
 * Must fit within Docker's 128-char container name limit after the `agent-`
 * prefix is applied.
 */
export function validateAgentId(agentId: string): void {
  if (
    agentId.length === 0 ||
    agentId.length > MAX_AGENT_ID_LENGTH ||
    hasControlChars(agentId) ||
    !/^[a-zA-Z0-9_-]+$/.test(agentId)
  ) {
    throw new Error(
      `Invalid agent ID "${agentId}": must be 1-${MAX_AGENT_ID_LENGTH} chars, alphanumeric / hyphens / underscores only.`,
    );
  }
}

/** Validate an agent name: printable characters, 1-64 chars, no shell metacharacters. */
export function validateAgentName(name: string): void {
  if (!name || name.length > 64) {
    throw new Error(`Invalid agent name: must be 1-64 characters.`);
  }
  // Block characters that could break shell commands even inside quotes
  if (hasControlChars(name)) {
    throw new Error(`Invalid agent name "${name}": contains control characters.`);
  }
}

/** Env keys must be shell-safe identifiers; allow lowercase for caller-supplied env vars. */
export function validateEnvKey(key: string): void {
  if (hasControlChars(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `Invalid environment variable key "${key}": must match ^[A-Za-z_][A-Za-z0-9_]*$.`,
    );
  }
}

/**
 * Env values are shell-safe once single-quoted, but we still reject control
 * characters so multi-line payloads and invisible bytes cannot reach the remote
 * shell command. Callers should pass a key so production errors are debuggable.
 */
export function validateEnvValue(key: string, value: string): void {
  if (hasControlChars(value)) {
    throw new Error(
      `Invalid environment variable value for key "${key}": contains control characters (newlines and PEM-encoded values are not supported).`,
    );
  }
}

/** Docker container names must be simple shell-safe identifiers. */
export function validateContainerName(containerName: string): void {
  if (hasControlChars(containerName) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)) {
    throw new Error(
      `Invalid container name "${containerName}": must match ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$.`,
    );
  }
}

/** Docker host volume paths must be absolute, normalized, and shell-safe. */
export function validateVolumePath(volumePath: string): void {
  // First allow only absolute shell-safe path characters, reject the root path,
  // then separately enforce normalized-form rules like no traversal, repeated
  // separators, or trailing slash.
  if (
    hasControlChars(volumePath) ||
    volumePath === "/" ||
    !/^\/[A-Za-z0-9._/-]+$/.test(volumePath)
  ) {
    throw new Error(`Invalid volume path "${volumePath}".`);
  }
  if (
    volumePath.includes("//") ||
    volumePath.includes("/./") ||
    volumePath.includes("/../") ||
    volumePath.endsWith("/.") ||
    volumePath.endsWith("/..") ||
    (volumePath.length > 1 && volumePath.endsWith("/"))
  ) {
    throw new Error(`Invalid volume path "${volumePath}": path must be normalized.`);
  }
}

// ---------------------------------------------------------------------------
// Steward / Docker host routing
// ---------------------------------------------------------------------------

/**
 * Resolve the URL injected into containers for talking back to Steward.
 *
 * - Explicit STEWARD_CONTAINER_URL wins.
 * - Otherwise, when the host-side Steward URL points at localhost/loopback,
 *   rewrite it to host.docker.internal for container reachability.
 * - Non-loopback host URLs pass through unchanged.
 */
export function resolveStewardContainerUrl(
  stewardHostUrl: string = process.env.STEWARD_API_URL || "http://localhost:8787/steward",
  stewardContainerUrl?: string,
): string {
  const override = stewardContainerUrl?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }

  let url: URL;
  try {
    url = new URL(stewardHostUrl);
  } catch {
    throw new Error(`[docker-sandbox] Invalid STEWARD_API_URL: ${JSON.stringify(stewardHostUrl)}`);
  }
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

/** Linux Docker needs an explicit host-gateway alias for host.docker.internal. */
export function requiresDockerHostGateway(targetUrl: string): boolean {
  try {
    return new URL(targetUrl).hostname === "host.docker.internal";
  } catch {
    return false;
  }
}

/**
 * Docker prints the created container ID on the final stdout line.
 * Validate that line so warnings or unexpected output do not get mistaken
 * for a container ID.
 */
export function extractDockerCreateContainerId(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let containerId: string | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (/^[0-9a-f]{12,64}$/i.test(line)) {
      containerId = line;
      break;
    }
  }

  if (!containerId) {
    const lastLine = lines.at(-1);
    throw new Error(
      `[docker-sandbox] docker create returned an invalid container id: ${JSON.stringify(lastLine ?? "")}`,
    );
  }

  return containerId.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Port Allocation
// ---------------------------------------------------------------------------

/**
 * Pick a random port in [min, max) that is not in the exclusion set.
 * TOCTOU safety: the DB has a partial UNIQUE index on (node_id, bridge_port)
 * for active sandboxes, so a duplicate insert will fail and the caller
 * should retry the entire provisioning flow.
 */
export function allocatePort(min: number, max: number, excluded: Set<number>): number {
  const range = max - min;
  if (excluded.size >= range) {
    throw new Error(
      `[docker-sandbox] No available ports in range [${min}, ${max}). All ${range} ports are allocated.`,
    );
  }
  let port: number;
  let attempts = 0;
  do {
    port = min + Math.floor(Math.random() * range);
    attempts++;
    if (attempts > range * 2) {
      throw new Error(
        `[docker-sandbox] Failed to find an available port in range [${min}, ${max}) after ${attempts} attempts.`,
      );
    }
  } while (excluded.has(port));
  return port;
}

export function readDockerHostPortFromMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const hostPort = (metadata as Record<string, unknown>).hostPort;
  if (typeof hostPort !== "number") return null;
  return Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null;
}

// ---------------------------------------------------------------------------
// Container Naming & Paths
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic container name from an agent ID.
 * Uses the full agentId to avoid collisions (truncated UUIDs share prefix
 * patterns and can collide on the same node).
 */
export function getContainerName(agentId: string): string {
  validateAgentId(agentId);
  const containerName = `${AGENT_CONTAINER_NAME_PREFIX}${agentId}`;
  // Keep this derived-output validation as a guardrail if the naming template changes.
  validateContainerName(containerName);
  return containerName;
}

/** Volume path on the Docker host for persistent agent data. */
export function getVolumePath(agentId: string): string {
  validateAgentId(agentId);
  const volumePath = `/data/agents/${agentId}`;
  validateVolumePath(volumePath);
  return volumePath;
}

// ---------------------------------------------------------------------------
// Durable per-agent vault state (#18080 / #19225)
// ---------------------------------------------------------------------------

/**
 * In-container state root injected as `ELIZA_STATE_DIR` on every provisioned
 * container. `/root/.eliza` is the `${volumePath}/eliza` bind mount, so the
 * state-dir vault (`.vault-pglite`), config, and media survive container
 * replacement/reschedule; without it the runtime resolves state to
 * `/root/.local/state/eliza` in the container's writable layer and every
 * replacement silently drops stored connector credentials.
 */
export const CONTAINER_DURABLE_STATE_DIR = "/root/.eliza";

/** Host-side path of the persisted per-agent vault master passphrase. */
export function getVolumeVaultPassphrasePath(volumePath: string): string {
  return `${volumePath}/.vault-passphrase`;
}

/**
 * Shell command that reads the per-agent vault master passphrase persisted on
 * the agent's host volume, creating it once (mode 0600 via umask, tmp+rename)
 * when absent — from `seedValue` when the operator injected one, otherwise 64
 * hex chars from /dev/urandom. Replacement container B over the same volume
 * therefore derives the same vault master key container A used — the key is
 * per agent, never derived from agent/org identifiers. A generated key never
 * transits a shell argument; an operator seed does, over the same ssh.exec
 * channel that already carries it inside `docker create -e`.
 */
export function buildVolumeVaultPassphraseCommand(volumePath: string, seedValue?: string): string {
  const keyFile = shellQuote(getVolumeVaultPassphrasePath(volumePath));
  const tmpFile = shellQuote(`${getVolumeVaultPassphrasePath(volumePath)}.tmp`);
  const writeKey =
    seedValue !== undefined
      ? `printf %s ${shellQuote(seedValue)} > ${tmpFile}`
      : `head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n' > ${tmpFile}`;
  // ponytail: tmp+mv is last-writer-wins on a concurrent FIRST provision;
  // upstream lifecycle locks serialize per-agent provisioning, and once the
  // file exists every later provision only reads it.
  return `test -s ${keyFile} || { umask 077; ${writeKey} && mv ${tmpFile} ${keyFile}; }; cat ${keyFile}`;
}

/**
 * Run {@link buildVolumeVaultPassphraseCommand} through `exec` (the node's
 * shell, e.g. over SSH) and validate the result. Fails closed on a short or
 * empty read — a fresh random per-launch key would silently orphan every
 * credential already encrypted on the volume.
 *
 * `operatorOverride` (an injected `ELIZA_VAULT_PASSPHRASE`) is not allowed to
 * bypass this lifecycle: the persisted key file stays the single source of
 * truth across container replacement. A first provision seeds the file with
 * the override, so a later replacement launched WITHOUT the override reads
 * the same key instead of minting a fresh one that cannot decrypt the
 * volume's existing vault ciphertext. If the file already holds a different
 * key, provisioning fails closed rather than guessing which key encrypted
 * the ciphertext.
 */
export async function ensureVolumeVaultPassphrase(
  exec: (cmd: string, timeoutMs: number) => Promise<string>,
  volumePath: string,
  timeoutMs: number,
  operatorOverride?: string,
): Promise<string> {
  // Empty/whitespace-only override means "not set" — same as the historical
  // `environmentVars.ELIZA_VAULT_PASSPHRASE?.trim() ||` fallthrough.
  const override = operatorOverride?.trim() || undefined;
  if (override !== undefined && (override.length < 12 || /\s/.test(override))) {
    // Validate BEFORE seeding: persisting an unusable override would brick
    // every subsequent launch on the post-write length check below.
    throw new ElizaError(
      `[docker-sandbox] injected ELIZA_VAULT_PASSPHRASE is unusable (length ${override.length}); refusing to seed ${getVolumeVaultPassphrasePath(volumePath)} with a key the vault would reject`,
      {
        code: "SANDBOX_VAULT_PASSPHRASE_OVERRIDE_UNUSABLE",
        context: { volumePath, passphraseLength: override.length },
      },
    );
  }
  const output = await exec(buildVolumeVaultPassphraseCommand(volumePath, override), timeoutMs);
  const passphrase = output.trim();
  // 12 chars is the vault's own passphraseMasterKey minimum; generated keys
  // are 64 hex chars, but an operator-provisioned key file is honored as-is.
  if (passphrase.length < 12 || /\s/.test(passphrase)) {
    throw new ElizaError(
      `[docker-sandbox] persisted vault passphrase at ${getVolumeVaultPassphrasePath(volumePath)} is unusable (length ${passphrase.length}); refusing to mint a fresh per-launch key that would orphan the volume's vault ciphertext`,
      {
        code: "SANDBOX_VAULT_PASSPHRASE_UNUSABLE",
        context: { volumePath, passphraseLength: passphrase.length },
      },
    );
  }
  if (override !== undefined && passphrase !== override) {
    throw new ElizaError(
      `[docker-sandbox] injected ELIZA_VAULT_PASSPHRASE does not match the key persisted at ${getVolumeVaultPassphrasePath(volumePath)}; that file is the durable source of truth for the volume's vault ciphertext — remove the override or rotate the key file deliberately`,
      {
        code: "SANDBOX_VAULT_PASSPHRASE_OVERRIDE_MISMATCH",
        context: { volumePath },
      },
    );
  }
  return passphrase;
}

// ---------------------------------------------------------------------------
// Node Configuration Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `CONTAINERS_DOCKER_NODES` (or legacy `AGENT_DOCKER_NODES`) env var.
 * Format: `nodeId:hostname:capacity,nodeId2:hostname2:capacity2`
 *
 * Result is cached at module level to avoid re-parsing on every call.
 */
let _cachedDockerNodes: DockerNodeEnv[] | null = null;
let _cachedDockerNodesRaw: string | undefined;

export function parseDockerNodes(): DockerNodeEnv[] {
  const raw = containersEnv.seedNodes();
  if (!raw) {
    throw new Error(
      "[docker-sandbox] No seed nodes configured. " +
        "Set CONTAINERS_DOCKER_NODES (or legacy AGENT_DOCKER_NODES) " +
        'in the format "nodeId:hostname:capacity,..."',
    );
  }

  // Return cached result if env var hasn't changed
  if (_cachedDockerNodes && _cachedDockerNodesRaw === raw) {
    return _cachedDockerNodes;
  }

  const nodes: DockerNodeEnv[] = [];
  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(":");
    if (parts.length < 3) {
      logger.warn(`[docker-sandbox] Skipping malformed node entry: "${trimmed}"`);
      continue;
    }

    const [nodeId, hostname, capacityStr] = parts;
    const capacity = parseInt(capacityStr!, 10);
    if (!nodeId || !hostname || isNaN(capacity) || capacity <= 0) {
      logger.warn(`[docker-sandbox] Skipping invalid node entry: "${trimmed}"`);
      continue;
    }

    nodes.push({ nodeId, hostname, capacity });
  }

  if (nodes.length === 0) {
    throw new Error("[docker-sandbox] No valid nodes parsed from AGENT_DOCKER_NODES");
  }

  _cachedDockerNodes = nodes;
  _cachedDockerNodesRaw = raw;
  return nodes;
}

/**
 * Which Headscale teardown applies to a container's VPN state (#16565).
 * During a blue/green overlap old and new nodes share the deterministic
 * hostname, so:
 *  - a registered id is the only safe deletion handle (`by-id`);
 *  - preserve-mode with NO registered id means the container never joined —
 *    the only same-name node is the LIVE preserved one, and by-name deletion
 *    is forbidden (`skip-preserved`);
 *  - plain provisions without an id fall back to the historical by-name
 *    cleanup (`by-name`) — nothing ambiguous exists there.
 * Pure so every caller (stop teardown, create-failure rollback) shares one
 * pinned decision instead of re-deriving it.
 */
export function resolveVpnTeardown(state: {
  vpnNodeId?: string;
  previousVpnNodeId?: string;
}): { kind: "by-id"; nodeId: string } | { kind: "by-name" } | { kind: "skip-preserved" } {
  if (state.vpnNodeId) return { kind: "by-id", nodeId: state.vpnNodeId };
  if (state.previousVpnNodeId) return { kind: "skip-preserved" };
  return { kind: "by-name" };
}
