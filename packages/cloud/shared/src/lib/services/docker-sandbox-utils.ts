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

const PUBLIC_CONTAINER_ENV_KEY_ALLOWLIST = new Set([
  "AGENT_DISABLE_AUTO_API_TOKEN",
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
]);

/**
 * Keep only fixed, non-secret feature flags on the Docker command line.
 * Caller-provided environment keys are arbitrary BYO-secret material, so an
 * unknown name must fail closed to the stdin-backed env file rather than rely
 * on a credential-name heuristic.
 */
export function isSecretContainerEnvKey(key: string): boolean {
  return !PUBLIC_CONTAINER_ENV_KEY_ALLOWLIST.has(key);
}

export interface DockerContainerEnvTransport {
  commandFlags: string[];
  secretInput: string;
}

export interface DockerEnvFileStdinTransport {
  /** Shell command whose environment-related argv contains only the temporary env-file path. */
  command: string;
  /** Versioned, bounded frame that must be delivered through an stdin-capable executor. */
  input: string;
}

export interface DockerEnvFileStdinTransportOptions {
  /** Override for isolated tests; production callers use restrictive files under `/tmp`. */
  temporaryDirectory?: string;
}

const CONTAINER_SECRET_ENV_STDIN_SENTINEL = "ELIZA_SECRET_ENV_STDIN_V1_END";
const DOCKER_ENV_FILE_STDIN_VERSION = "ELIZA_DOCKER_ENV_FILE_STDIN_V1";
const DOCKER_ENV_FILE_STDIN_END = "ELIZA_DOCKER_ENV_FILE_STDIN_V1_END";
const DOCKER_ENV_FILE_STDIN_LENGTH_DIGITS = 6;
const DOCKER_ENV_FILE_STDIN_HEADER_BYTES = Buffer.byteLength(
  `${DOCKER_ENV_FILE_STDIN_VERSION} ${"0".repeat(DOCKER_ENV_FILE_STDIN_LENGTH_DIGITS)}\n`,
);
const DOCKER_ENV_FILE_STDIN_END_BYTES = Buffer.byteLength(`${DOCKER_ENV_FILE_STDIN_END}\n`);
const MAX_DOCKER_ENV_TRANSPORT_BYTES = 256 * 1024;
const MAX_DOCKER_PROCESS_ENV_ENTRY_BYTES = 120 * 1024;
const MAX_DOCKER_ENV_FILE_LINE_BYTES = 60 * 1024;
const RESERVED_DOCKER_ENV_TRANSPORT_KEYS = new Set(["env_file", "env_frame_file", "env_end_file"]);
const DOCKER_CLIENT_CONTROL_ENV_KEYS = new Set([
  "ALL_PROXY",
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "ENV",
  "EUID",
  "GLOBIGNORE",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "IFS",
  "LANG",
  "LINENO",
  "LOGNAME",
  "NO_PROXY",
  "OLDPWD",
  "OPTARG",
  "OPTIND",
  "PATH",
  "POSIXLY_CORRECT",
  "PPID",
  "PROMPT_COMMAND",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PWD",
  "RANDOM",
  "SECONDS",
  "SHELL",
  "SHELLOPTS",
  "SHLVL",
  "SSH_AUTH_SOCK",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "UID",
  "USER",
  "_",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

function isDockerClientControlEnvKey(key: string): boolean {
  if (
    /^(?:DOCKER_|LD_|DYLD_|XDG_|LC_|MALLOC_)/.test(key) ||
    /^(?:GODEBUG|GOMAXPROCS|GOMEMLIMIT|GOTRACEBACK)$/.test(key)
  ) {
    return true;
  }
  return DOCKER_CLIENT_CONTROL_ENV_KEYS.has(key);
}

interface DockerEnvironmentPartition {
  processEnvironment: Record<string, string>;
  envFileBody: string;
}

/**
 * Partition an arbitrary container environment without allowing it to steer
 * the shell wrapper or Docker client. Ordinary values are exported only so a
 * key-only env-file entry can copy them into the container. Docker/shell
 * control variables remain explicit env-file records and never reach the
 * provisioning process environment.
 */
function partitionDockerEnvironment(
  environment: Readonly<Record<string, string>>,
): DockerEnvironmentPartition {
  // A valid POSIX env key may be `__proto__`; a null-prototype record keeps it
  // as data instead of invoking Object.prototype's legacy setter.
  const processEnvironment = Object.create(null) as Record<string, string>;
  const envFileLines: string[] = [];
  let rawBytes = 0;

  for (const [key, value] of Object.entries(environment)) {
    validateEnvKey(key);
    if (RESERVED_DOCKER_ENV_TRANSPORT_KEYS.has(key)) {
      throw new Error(`Environment variable "${key}" is reserved by the Docker stdin transport.`);
    }
    if (value.includes("\0")) {
      throw new Error(`Invalid environment variable value for key "${key}": contains NUL.`);
    }

    const entryBytes = Buffer.byteLength(`${key}=${value}`);
    if (entryBytes > MAX_DOCKER_PROCESS_ENV_ENTRY_BYTES) {
      throw new Error(
        `Environment variable "${key}" exceeds the ${MAX_DOCKER_PROCESS_ENV_ENTRY_BYTES}-byte process entry limit.`,
      );
    }
    rawBytes += entryBytes + 1;
    if (rawBytes > MAX_DOCKER_ENV_TRANSPORT_BYTES) {
      throw new Error(
        `Container environment exceeds the ${MAX_DOCKER_ENV_TRANSPORT_BYTES}-byte transport limit.`,
      );
    }

    if (isDockerClientControlEnvKey(key)) {
      if (value.includes("\n") || value.includes("\r")) {
        throw new Error(
          `Docker client control variable "${key}" must be single-line so it cannot alter the provisioning client.`,
        );
      }
      if (entryBytes > MAX_DOCKER_ENV_FILE_LINE_BYTES) {
        throw new Error(
          `Docker client control variable "${key}" exceeds the ${MAX_DOCKER_ENV_FILE_LINE_BYTES}-byte env-file line limit.`,
        );
      }
      envFileLines.push(`${key}=${value}`);
      continue;
    }

    processEnvironment[key] = value;
    envFileLines.push(key);
  }

  return {
    processEnvironment,
    envFileBody: envFileLines.length > 0 ? `${envFileLines.join("\n")}\n` : "",
  };
}

function buildDockerEnvironmentFrame(environment: Readonly<Record<string, string>>): string {
  const partition = partitionDockerEnvironment(environment);
  const exportLines = Object.entries(partition.processEnvironment).map(
    ([key, value]) => `export ${key}=${shellQuote(value)}`,
  );
  const envScript = [
    ...exportLines,
    `printf '%s' ${shellQuote(partition.envFileBody)} > "$env_file"`,
  ].join("\n");
  const framedScript = `${envScript}\n`;
  const framedScriptBytes = Buffer.byteLength(framedScript);
  if (framedScriptBytes > MAX_DOCKER_ENV_TRANSPORT_BYTES) {
    throw new Error(
      `Container environment frame exceeds the ${MAX_DOCKER_ENV_TRANSPORT_BYTES}-byte transport limit.`,
    );
  }
  const encodedLength = String(framedScriptBytes).padStart(
    DOCKER_ENV_FILE_STDIN_LENGTH_DIGITS,
    "0",
  );
  return `${DOCKER_ENV_FILE_STDIN_VERSION} ${encodedLength}\n${framedScript}${DOCKER_ENV_FILE_STDIN_END}\n`;
}

/** Validate the exact bounded stdin frame before callers mutate container state. */
export function validateDockerEnvFileStdinEnvironment(
  environment: Readonly<Record<string, string>>,
): void {
  buildDockerEnvironmentFrame(environment);
}

/**
 * Build a one-shot, stdin-only Docker environment transport. The remote shell
 * accepts exactly one bounded frame, creates restrictive temporary files,
 * verifies the terminal sentinel and EOF, and removes every file on success,
 * failure, timeout-driven HUP, or another handled signal.
 */
export function buildDockerEnvFileStdinTransport(
  environment: Readonly<Record<string, string>>,
  buildDockerCommand: (envFilePath: string) => string,
  options: DockerEnvFileStdinTransportOptions = {},
): DockerEnvFileStdinTransport {
  const input = buildDockerEnvironmentFrame(environment);
  const temporaryDirectory = options.temporaryDirectory ?? "/tmp";
  validateVolumePath(temporaryDirectory);

  const envFrameTemplate = shellQuote(`${temporaryDirectory}/eliza-docker-env-frame.XXXXXX`);
  const envFileTemplate = shellQuote(`${temporaryDirectory}/eliza-docker-env.XXXXXX`);
  const envEndFileTemplate = shellQuote(`${temporaryDirectory}/eliza-docker-env-end.XXXXXX`);
  const dockerCommand = buildDockerCommand('"$env_file"');
  if (!dockerCommand.trim()) {
    throw new Error("Docker env-file stdin transport requires a non-empty command.");
  }

  return {
    input,
    command: [
      "set -eu",
      "env_frame_file=",
      "env_file=",
      "env_end_file=",
      'cleanup_env_files() { test -z "$env_frame_file" || rm -f "$env_frame_file"; test -z "$env_end_file" || rm -f "$env_end_file"; test -z "$env_file" || rm -f "$env_file"; }',
      "trap cleanup_env_files EXIT",
      "trap 'exit 1' HUP INT TERM",
      "umask 077",
      `env_frame_file=$(mktemp ${envFrameTemplate})`,
      `env_file=$(mktemp ${envFileTemplate})`,
      `env_end_file=$(mktemp ${envEndFileTemplate})`,
      'chmod 600 "$env_frame_file" "$env_end_file" "$env_file"',
      `dd bs=1 count=${DOCKER_ENV_FILE_STDIN_HEADER_BYTES} of="$env_frame_file" status=none`,
      `test "$(wc -c < "$env_frame_file" | tr -d ' ')" = ${DOCKER_ENV_FILE_STDIN_HEADER_BYTES}`,
      'env_header=$(cat "$env_frame_file")',
      `case "$env_header" in ${shellQuote(`${DOCKER_ENV_FILE_STDIN_VERSION} `)}??????) ;; *) exit 44 ;; esac`,
      `env_length_padded=\${env_header#${DOCKER_ENV_FILE_STDIN_VERSION} }`,
      "case \"$env_length_padded\" in ''|*[!0-9]*) exit 44 ;; esac",
      "env_length=$(printf %s \"$env_length_padded\" | sed 's/^0*//')",
      'test -n "$env_length" || env_length=0',
      `test "$env_length" -le ${MAX_DOCKER_ENV_TRANSPORT_BYTES}`,
      'if test "$env_length" -gt 0; then dd bs=1 count="$env_length" of="$env_frame_file" status=none; else : > "$env_frame_file"; fi',
      "env_actual_length=$(wc -c < \"$env_frame_file\" | tr -d ' ')",
      'test "$env_actual_length" = "$env_length"',
      `dd bs=1 count=${DOCKER_ENV_FILE_STDIN_END_BYTES} of="$env_end_file" status=none`,
      `test "$(wc -c < "$env_end_file" | tr -d ' ')" = ${DOCKER_ENV_FILE_STDIN_END_BYTES}`,
      `test "$(cat "$env_end_file")" = ${shellQuote(DOCKER_ENV_FILE_STDIN_END)}`,
      "test \"$(dd bs=1 count=1 status=none | wc -c | tr -d ' ')\" = 0",
      '. "$env_frame_file"',
      'chmod 600 "$env_file"',
      dockerCommand,
    ].join("; "),
  };
}

/** Split validated container env into visible flags and stdin-only entries. */
export function buildDockerContainerEnvTransport(
  environment: Readonly<Record<string, string>>,
): DockerContainerEnvTransport {
  const commandFlags: string[] = [];
  const secretLines: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    validateEnvKey(key);
    validateEnvValue(key, value);
    if (isSecretContainerEnvKey(key)) {
      secretLines.push(`${key}=${value}`);
    } else {
      commandFlags.push(`-e ${shellQuote(`${key}=${value}`)}`);
    }
  }
  return {
    commandFlags,
    secretInput: `${secretLines.length > 0 ? `${secretLines.join("\n")}\n` : ""}ELIZA_VAULT_PASSPHRASE=\n${CONTAINER_SECRET_ENV_STDIN_SENTINEL}\n`,
  };
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

const VOLUME_VAULT_STDIN_FRAME_VERSION = "ELIZA_VAULT_STDIN_V1";
const VOLUME_VAULT_STDIN_FRAME_END = "ELIZA_VAULT_STDIN_V1_END";

/** Host-side path of the persisted per-agent vault master passphrase. */
export function getVolumeVaultPassphrasePath(volumePath: string): string {
  return `${volumePath}/.vault-passphrase`;
}

/**
 * Shell command that establishes and validates the per-agent vault master
 * passphrase persisted on the host volume. A versioned frame containing an
 * optional operator seed arrives only on stdin; the command emits no
 * passphrase bytes. Replacement containers therefore derive the same
 * per-volume key without exposing it to the caller.
 */
export function buildVolumeVaultPassphraseCommand(
  volumePath: string,
  overrideByteLength = 0,
): string {
  if (!Number.isSafeInteger(overrideByteLength) || overrideByteLength < 0) {
    throw new Error("Vault passphrase override byte length must be a non-negative integer.");
  }
  const keyPath = getVolumeVaultPassphrasePath(volumePath);
  const keyFile = shellQuote(keyPath);
  const stdinFile = `${shellQuote(`${keyPath}.stdin`)}.$$`;
  const overrideFile = `${shellQuote(`${keyPath}.override`)}.$$`;
  const generatedFile = `${shellQuote(`${keyPath}.generated`)}.$$`;
  const normalizedFile = `${shellQuote(`${keyPath}.normalized`)}.$$`;
  const expectedHeader = `${VOLUME_VAULT_STDIN_FRAME_VERSION} ${overrideByteLength}`;
  const expectedFrameByteLength =
    Buffer.byteLength(expectedHeader) +
    1 +
    overrideByteLength +
    1 +
    Buffer.byteLength(VOLUME_VAULT_STDIN_FRAME_END) +
    1;
  return [
    "set -eu",
    `stdin_file=${stdinFile}`,
    `override_file=${overrideFile}`,
    `generated_file=${generatedFile}`,
    `normalized_file=${normalizedFile}`,
    'trap \'rm -f "$stdin_file" "$override_file" "$generated_file" "$normalized_file"\' EXIT',
    "trap 'exit 1' HUP INT TERM",
    "umask 077",
    'cat > "$stdin_file"',
    `stdin_length=$(wc -c < "$stdin_file" | tr -d ' ')`,
    `if test "$stdin_length" != ${expectedFrameByteLength}; then exit 44; fi`,
    `frame_header=$(sed -n '1p' "$stdin_file")`,
    `if test "$frame_header" != ${shellQuote(expectedHeader)}; then exit 44; fi`,
    "frame_lines=$(awk 'END { print NR }' \"$stdin_file\")",
    'if test "$frame_lines" != 3; then exit 44; fi',
    `if test "$(tail -n 1 "$stdin_file")" != ${shellQuote(VOLUME_VAULT_STDIN_FRAME_END)}; then exit 44; fi`,
    'sed \'1d;$d\' "$stdin_file" > "$override_file"',
    "override_framed_length=$(wc -c < \"$override_file\" | tr -d ' ')",
    'if test "$override_framed_length" -lt 1; then exit 44; fi',
    'truncate -s -1 "$override_file"',
    "override_length=$(wc -c < \"$override_file\" | tr -d ' ')",
    `if test "$override_length" != ${overrideByteLength}; then exit 44; fi`,
    'if test -s "$override_file"; then override_safe_length=$(LC_ALL=C tr -d \'[:space:][:cntrl:]\' < "$override_file" | wc -c | tr -d \' \'); if test "$override_length" -lt 12 || test "$override_length" != "$override_safe_length"; then exit 43; fi; fi',
    `if test ! -s ${keyFile}; then if test -s "$override_file"; then candidate_file="$override_file"; else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n' > "$generated_file"; candidate_file="$generated_file"; fi; if ln "$candidate_file" ${keyFile} 2>/dev/null; then :; elif test -s ${keyFile}; then :; else exit 43; fi; fi`,
    // A shell variable cannot represent NUL bytes: command substitution would
    // silently delete them and rewrite the durable key. Validate the raw file
    // before normalization, accepting at most one trailing newline from an
    // operator-provisioned text file and rejecting every other control byte.
    `line_count=$(awk 'END { print NR }' ${keyFile})`,
    'if test "$line_count" != 1; then exit 43; fi',
    `tr -d '\\n' < ${keyFile} > "$normalized_file"`,
    `key_length=$(wc -c < "$normalized_file" | tr -d ' ')`,
    `safe_length=$(LC_ALL=C tr -d '[:space:][:cntrl:]' < "$normalized_file" | wc -c | tr -d ' ')`,
    'if test "$key_length" -lt 12 || test "$key_length" != "$safe_length"; then exit 43; fi',
    `if ! cmp -s "$normalized_file" ${keyFile}; then mv "$normalized_file" ${keyFile}; fi`,
    `chmod 600 ${keyFile}`,
    `if test -s "$override_file" && ! cmp -s "$override_file" ${keyFile}; then exit 42; fi`,
  ].join("; ");
}

/**
 * Run {@link buildVolumeVaultPassphraseCommand} through an stdin-capable node
 * shell and validate the result remotely. Fails closed on a short or empty
 * key — a fresh random per-launch key would silently orphan every
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
  execStdin: (cmd: string, input: string, timeoutMs: number) => Promise<string>,
  volumePath: string,
  timeoutMs: number,
  operatorOverride?: string,
): Promise<void> {
  // Validate the raw value before trim or SSH. Shell variables cannot carry
  // NUL, and the remote create-if-absent step may durably link its stdin file
  // before raw-file validation runs. No control-bearing candidate may reach
  // that mutation boundary.
  if (
    operatorOverride !== undefined &&
    Array.from(operatorOverride).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new ElizaError(
      `[docker-sandbox] injected vault override is unusable (length ${operatorOverride.length}); refusing to seed ${getVolumeVaultPassphrasePath(volumePath)} with a key the vault would reject`,
      {
        code: "SANDBOX_VAULT_PASSPHRASE_OVERRIDE_UNUSABLE",
        context: { volumePath, passphraseLength: operatorOverride.length },
      },
    );
  }
  // Empty/whitespace-only override means "not set" — same as the historical
  // `environmentVars.ELIZA_VAULT_PASSPHRASE?.trim() ||` fallthrough.
  const override = operatorOverride?.trim() || undefined;
  if (override !== undefined && (override.length < 12 || /\s/.test(override))) {
    // Validate BEFORE seeding: persisting an unusable override would brick
    // every subsequent launch on the post-write length check below.
    throw new ElizaError(
      `[docker-sandbox] injected vault override is unusable (length ${override.length}); refusing to seed ${getVolumeVaultPassphrasePath(volumePath)} with a key the vault would reject`,
      {
        code: "SANDBOX_VAULT_PASSPHRASE_OVERRIDE_UNUSABLE",
        context: { volumePath, passphraseLength: override.length },
      },
    );
  }
  const overrideBytes = Buffer.byteLength(override ?? "", "utf8");
  const framedOverride = `${VOLUME_VAULT_STDIN_FRAME_VERSION} ${overrideBytes}\n${override ?? ""}\n${VOLUME_VAULT_STDIN_FRAME_END}\n`;
  try {
    await execStdin(
      buildVolumeVaultPassphraseCommand(volumePath, overrideBytes),
      framedOverride,
      timeoutMs,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const exitCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { code?: unknown }).code
        : undefined;
    if (exitCode === 42 || message.includes("exited with code 42")) {
      throw new ElizaError(
        `[docker-sandbox] injected vault override does not match the key persisted at ${getVolumeVaultPassphrasePath(volumePath)}; that file remains the durable source of truth`,
        {
          code: "SANDBOX_VAULT_PASSPHRASE_OVERRIDE_MISMATCH",
          context: { volumePath },
          cause,
        },
      );
    }
    if (exitCode === 43 || message.includes("exited with code 43")) {
      throw new ElizaError(
        `[docker-sandbox] persisted vault passphrase at ${getVolumeVaultPassphrasePath(volumePath)} is unusable; refusing to mint a fresh per-launch key`,
        {
          code: "SANDBOX_VAULT_PASSPHRASE_UNUSABLE",
          context: { volumePath },
          cause,
        },
      );
    }
    if (exitCode === 44 || message.includes("exited with code 44")) {
      throw new ElizaError(
        `[docker-sandbox] vault passphrase transport to ${getVolumeVaultPassphrasePath(volumePath)} was incomplete or invalid; refusing to change durable vault state`,
        {
          code: "SANDBOX_VAULT_PASSPHRASE_STDIN_INCOMPLETE",
          context: { volumePath },
          cause,
        },
      );
    }
    throw cause;
  }
}

/** Unique restrictive env file used only for one remote `docker create`. */
export function getContainerSecretEnvPath(
  volumePath: string,
  replacementAttemptId: string,
): string {
  if (!/^[a-f0-9-]{36}$/i.test(replacementAttemptId)) {
    throw new Error("Invalid replacement attempt ID for container secret environment file.");
  }
  return `${volumePath}/.container-env-${replacementAttemptId}`;
}

/**
 * Wrap `docker create` so stdin becomes a 0600 env file, the persisted vault
 * value is appended without being read by the caller, and every shell exit
 * removes the file.
 */
export function buildDockerCreateWithSecretEnvCommand(options: {
  dockerCreateCommand: string;
  secretEnvPath: string;
  vaultPassphrasePath: string;
}): string {
  const envFile = shellQuote(options.secretEnvPath);
  const envBodyFile = shellQuote(`${options.secretEnvPath}.body`);
  const vaultFile = shellQuote(options.vaultPassphrasePath);
  return [
    "set -eu",
    `env_file=${envFile}`,
    `env_body_file=${envBodyFile}`,
    'trap \'rm -f "$env_file" "$env_body_file"\' EXIT',
    "trap 'exit 1' HUP INT TERM",
    "umask 077",
    'cat > "$env_file"',
    `test "$(tail -n 1 "$env_file")" = ${shellQuote(CONTAINER_SECRET_ENV_STDIN_SENTINEL)}`,
    'sed \'$d\' "$env_file" > "$env_body_file"',
    'mv "$env_body_file" "$env_file"',
    'truncate -s -1 "$env_file"',
    `cat ${vaultFile} >> "$env_file"`,
    "printf '\\n' >> \"$env_file\"",
    'chmod 600 "$env_file"',
    options.dockerCreateCommand,
  ].join("; ");
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
