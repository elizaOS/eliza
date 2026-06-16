/**
 * DockerSandboxProvider — SandboxProvider implementation for Docker containers
 * on remote VPS nodes.
 *
 * Manages the full lifecycle: create (pull image + docker run), stop/remove,
 * health-check, and arbitrary command execution inside containers.
 *
 * Reference: eliza-cloud/backend/services/container-orchestrator.ts
 */

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import { isAgentTokenSigningConfigured, mintAgentToken } from "../auth/agent-token";
import { containersEnv } from "../config/containers-env";
import { getAgentBaseDomain } from "../eliza-agent-web-ui";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { signStewardMutatingRequest } from "../steward/sign";
import { resolveServerStewardApiUrlFromEnv } from "../steward-url";
import { logger } from "../utils/logger";
import { getNodeAutoscaler } from "./containers/node-autoscaler";
import { resolveImageDigest } from "./containers/registry-probe";
import { isAlreadyGoneMessage } from "./docker-error-classifier";
import { dockerNodeManager } from "./docker-node-manager";
import { getUsedDockerHostPorts } from "./docker-port-allocation";
import {
  allocatePort,
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  buildEnsureNetworkCmd,
  dockerPlatformFlag,
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
import { DockerSSHClient } from "./docker-ssh";
import { headscaleIntegration } from "./headscale-integration";
import type { SandboxCreateConfig, SandboxHandle, SandboxProvider } from "./sandbox-provider-types";
import {
  ensureStewardTenant,
  resolveStewardTenantCredentials,
  type StewardTenantCredentials,
} from "./steward-tenant-config";

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
  /**
   * Registry-resolved sha256 digest of `dockerImage` at provision time.
   * Null when the image is not on a supported registry (e.g. a local-only
   * name) or the registry was unreachable. The fleet-upgrade reconciler
   * uses this to detect when the tag's digest has moved.
   */
  imageDigest: string | null;
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
  /** Headscale node name (TS_HOSTNAME) used at registration, for cleanup lookup. */
  tsHostname?: string;
  sshPort: number;
  sshUser: string;
  hostKeyFingerprint?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOCKER_IMAGE_OVERRIDE = containersEnv.defaultAgentImageOverride();
const DOCKER_NETWORK = containersEnv.dockerNetwork();
let hasWarnedMissingStewardTenantApiKey = false;

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

const STEWARD_JWT_FILE = "/app/data/steward.jwt";

export function resolveDockerSandboxImage(
  dockerImage?: string,
  operatorOverride = DOCKER_IMAGE_OVERRIDE,
): string {
  return dockerImage || operatorOverride || "ghcr.io/elizaos/eliza:latest";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveElizaCloudPublicUrl(): string {
  const env = getCloudAwareEnv();
  const candidates = [
    env.ELIZA_CLOUD_PUBLIC_URL,
    env.PUBLIC_URL,
    env.NEXT_PUBLIC_API_URL,
    env.NEXT_PUBLIC_APP_URL,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    return trimTrailingSlash(candidate.trim());
  }
  return "https://elizacloud.ai/api";
}

function resolveStewardRefreshUrl(): string {
  const env = getCloudAwareEnv();
  if (typeof env.STEWARD_REFRESH_URL === "string" && env.STEWARD_REFRESH_URL.trim()) {
    return env.STEWARD_REFRESH_URL.trim();
  }
  return `${resolveElizaCloudPublicUrl()}/v1/agent-tokens`;
}

function resolveStewardRefreshServiceToken(): string {
  const env = getCloudAwareEnv();
  for (const candidate of [env.ELIZA_CLOUD_SERVICE_TOKEN, env.AGENT_TOKEN_SERVICE_TOKEN]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/**
 * Strip secret-bearing fields from a persisted character before it is injected
 * into the container as ELIZA_AGENT_CHARACTER_JSON. The container receives the
 * actual connector tokens / API keys via dedicated env vars; embedding them in
 * the character JSON would expose them via /proc/<pid>/environ and crash
 * diagnostics for no benefit. Redacts:
 *   - top-level `secrets`
 *   - `settings.secrets`
 *   - per-connector `token` / `botToken` / `apiToken` under `connectors.*`
 * Persona + connector POLICY fields (dmPolicy, messagePrefix, enabled, etc.)
 * are preserved so the runtime still loads the right character + behaviour.
 */
function redactCharacterSecrets(character: Record<string, unknown>): Record<string, unknown> {
  // Deep clone so we never mutate the caller's DB-derived object.
  const clone = JSON.parse(JSON.stringify(character)) as Record<string, unknown>;
  delete clone.secrets;
  if (clone.settings && typeof clone.settings === "object") {
    delete (clone.settings as Record<string, unknown>).secrets;
  }
  const connectors = clone.connectors;
  if (connectors && typeof connectors === "object") {
    for (const value of Object.values(connectors as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const c = value as Record<string, unknown>;
        delete c.token;
        delete c.botToken;
        delete c.apiToken;
      }
    }
  }
  return clone;
}

/**
 * Resolve the AGENT_SERVER_SHARED_SECRET to inject into a provisioned
 * container so it can validate the X-Server-Token the cloud gateways attach to
 * forwarded platform messages. Precedence:
 *   1. An explicit per-deployment value in the sandbox's environment_vars.
 *   2. The daemon's own AGENT_SERVER_SHARED_SECRET (the same value the
 *      gateways read), so both ends share one secret with no extra config.
 * Returns an empty object when neither is set, leaving the container's
 * X-Server-Token path disabled (no regression).
 */
function resolveServerSharedSecretEnv(
  environmentVars: Record<string, string>,
): Record<string, string> {
  const explicit = environmentVars.AGENT_SERVER_SHARED_SECRET;
  if (typeof explicit === "string" && explicit.trim()) {
    return { AGENT_SERVER_SHARED_SECRET: explicit.trim() };
  }
  const env = getCloudAwareEnv();
  const daemonSecret = env.AGENT_SERVER_SHARED_SECRET;
  if (typeof daemonSecret === "string" && daemonSecret.trim()) {
    return { AGENT_SERVER_SHARED_SECRET: daemonSecret.trim() };
  }
  return {};
}

function resolveStewardElizaPluginPackage(): string {
  const env = getCloudAwareEnv();
  return typeof env.STEWARD_ELIZA_PLUGIN_PACKAGE === "string" &&
    env.STEWARD_ELIZA_PLUGIN_PACKAGE.trim()
    ? env.STEWARD_ELIZA_PLUGIN_PACKAGE.trim()
    : "@stwd/eliza-plugin";
}

function shouldInstallStewardPlugin(
  agentId: string,
  environmentVars: Record<string, string>,
): boolean {
  const env = getCloudAwareEnv();
  return (
    agentId.toLowerCase() === "sol" ||
    environmentVars.STEWARD_ENABLE_TRADE_PLUGIN === "true" ||
    env.STEWARD_ENABLE_TRADE_PLUGIN === "true"
  );
}

type HeadscaleRouteEnv = Partial<
  Record<
    | "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK"
    | "CONTAINERS_PUBLIC_BASE_DOMAIN"
    | "ELIZA_CLOUD_AGENT_BASE_DOMAIN"
    | "ENVIRONMENT"
    | "HEADSCALE_API_KEY"
    | "HEADSCALE_API_URL"
    | "HEADSCALE_PUBLIC_URL",
    string | undefined
  >
>;

function isBridgeHostFallbackEnabled(env: HeadscaleRouteEnv): boolean {
  return (
    env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK === "true" ||
    env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK === "1"
  );
}

function hasConfiguredValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function isCloudDeploymentEnvironment(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "production" || normalized === "staging";
}

export function requiresHeadscaleRoute(
  env: HeadscaleRouteEnv = (() => {
    // Bind once: calling getCloudAwareEnv() per-key creates a fresh Proxy
    // per call. If the underlying CF bindings flip mid-evaluation, the eight
    // reads would not see a consistent snapshot. Pin a single proxy and read
    // every key from it (Copilot review on #8152).
    const cloudEnv = getCloudAwareEnv();
    return {
      AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: cloudEnv.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK,
      CONTAINERS_PUBLIC_BASE_DOMAIN: cloudEnv.CONTAINERS_PUBLIC_BASE_DOMAIN,
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: cloudEnv.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
      ENVIRONMENT: cloudEnv.ENVIRONMENT,
      HEADSCALE_API_KEY: cloudEnv.HEADSCALE_API_KEY,
      HEADSCALE_API_URL: cloudEnv.HEADSCALE_API_URL,
      HEADSCALE_PUBLIC_URL: cloudEnv.HEADSCALE_PUBLIC_URL,
    };
  })(),
): boolean {
  if (isBridgeHostFallbackEnabled(env)) return false;
  return (
    hasConfiguredValue(env.HEADSCALE_API_KEY) ||
    hasConfiguredValue(env.HEADSCALE_API_URL) ||
    hasConfiguredValue(env.HEADSCALE_PUBLIC_URL) ||
    hasConfiguredValue(env.ELIZA_CLOUD_AGENT_BASE_DOMAIN) ||
    hasConfiguredValue(env.CONTAINERS_PUBLIC_BASE_DOMAIN) ||
    isCloudDeploymentEnvironment(env.ENVIRONMENT)
  );
}

function buildStewardRefreshCommand(
  containerName: string,
  agentId: string,
  serviceToken: string,
): string {
  const refreshScript = [
    "set -eu",
    `agent_id=${shellQuote(agentId)}`,
    `refresh_url=${shellQuote(resolveStewardRefreshUrl())}`,
    `jwt_file=${shellQuote(STEWARD_JWT_FILE)}`,
    `service_token=${shellQuote(serviceToken)}`,
    "while true; do",
    '  response=$(curl -fsS -X POST "$refresh_url" -H "content-type: application/json" -H "authorization: Bearer $service_token" --data "{\\"agentId\\":\\"$agent_id\\",\\"ttl\\":900}" || true)',
    '  token=$(printf "%s" "$response" | sed -n "s/.*\\"token\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p")',
    '  if [ -n "$token" ]; then',
    "    umask 077",
    '    printf "%s" "$token" > "$jwt_file"',
    '    echo "[steward-jwt-refresh] refreshed token for $agent_id at $(date -Iseconds)"',
    "  else",
    '    echo "[steward-jwt-refresh] refresh failed for $agent_id at $(date -Iseconds)" >&2',
    "  fi",
    "  sleep 600",
    "done",
  ].join("; ");

  return `docker exec -d ${shellQuote(containerName)} sh -lc ${shellQuote(refreshScript)}`;
}

function buildStewardPluginInstallCommand(containerName: string): string {
  const pluginPackage = resolveStewardElizaPluginPackage();
  const installScript = [
    "set -eu",
    `npm install --prefix /app --save ${shellQuote(pluginPackage)}`,
    `echo ${shellQuote(`[steward-plugin] installed ${pluginPackage}`)}`,
  ].join("; ");
  return `docker exec ${shellQuote(containerName)} sh -lc ${shellQuote(installScript)}`;
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

/** Autoscaled node readiness polling. */
const AUTOSCALED_NODE_READY_TIMEOUT_MS = 4 * 60 * 1000;
const AUTOSCALED_NODE_READY_POLL_MS = 10_000;

function getDockerHealthCmd(port: string, path = "/api/health"): string {
  if (!/^\d+$/.test(port)) {
    throw new Error(`[docker-sandbox] Invalid port "${port}": must be a numeric string.`);
  }
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(path)) {
    throw new Error(`[docker-sandbox] Invalid health check path "${path}".`);
  }
  // /api/health returns 200 or 401 (auth required) — both mean the server is up.
  // Use curl with -o /dev/null and check status code to accept either.
  return `sh -lc 'STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}${path}" 2>/dev/null); [ "$STATUS" = "200" ] || [ "$STATUS" = "401" ]'`;
}

export function resolveContainerPort(config: SandboxCreateConfig): string {
  const requested =
    typeof config.environmentVars.PORT === "string" && config.environmentVars.PORT.trim()
      ? config.environmentVars.PORT.trim()
      : typeof config.environmentVars.HTTP_PORT === "string" &&
          config.environmentVars.HTTP_PORT.trim()
        ? config.environmentVars.HTTP_PORT.trim()
        : typeof config.container?.port === "number"
          ? String(config.container.port)
          : DEFAULT_AGENT_PORT;
  if (!/^\d+$/.test(requested)) {
    throw new Error(`[docker-sandbox] Invalid container port "${requested}".`);
  }
  return requested;
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

function resolveStewardRequestSigningSecret(apiKey?: string): string | undefined {
  const env = getCloudAwareEnv();
  const explicit = env.STEWARD_REQUEST_SIGNING_SECRET?.trim();
  if (explicit) {
    return explicit;
  }
  const fromList = env.STEWARD_REQUEST_SIGNING_SECRETS?.split(",")
    .map((secret) => secret.trim())
    .find((secret) => secret.length > 0);
  return fromList ?? apiKey?.trim() ?? undefined;
}

function resolveStewardPlatformKey(): string | undefined {
  const env = getCloudAwareEnv();
  const single = env.STEWARD_PLATFORM_KEY?.trim();
  if (single) return single;
  const fromList = env.STEWARD_PLATFORM_KEYS?.split(",")
    .map((k) => k.trim())
    .find((k) => k.length > 0);
  return fromList || undefined;
}

function buildPlatformAgentPath(tenantId: string, agentId?: string): string {
  const base = `/platform/tenants/${encodeURIComponent(tenantId)}/agents`;
  return agentId ? `${base}/${encodeURIComponent(agentId)}` : base;
}

// Best-effort `curl -X DELETE` against Steward's platform agent endpoint for
// cleanup paths (failed container create, missing Headscale registration).
// Uses the platform-key path so the daemon authenticates as a platform
// operator instead of impersonating a tenant owner session — Steward's
// `/agents/:id` (tenant-scoped) route requires `session-jwt + tenantRole
// owner|admin`, which a backend service cannot satisfy. The platform-key
// path `/platform/tenants/:id/agents/:id` is exactly what Steward exposes
// for this case (scope `platform:agent:delete`). Without signing the call
// 401s and the agent record stays around as a ghost, blocking retries.
async function buildSignedDeleteAgentCurl(
  agentId: string,
  stewardTenant: StewardTenantCredentials,
): Promise<string> {
  const path = buildPlatformAgentPath(stewardTenant.tenantId, agentId);
  const url = `${resolveStewardHostUrl()}${path}`;
  const platformKey = resolveStewardPlatformKey();
  const signingSecret = resolveStewardRequestSigningSecret(stewardTenant.apiKey);
  const flags = [
    `-H ${shellQuote(`X-Steward-Tenant: ${stewardTenant.tenantId}`)}`,
    ...(platformKey ? [`-H ${shellQuote(`X-Steward-Platform-Key: ${platformKey}`)}`] : []),
  ];
  if (signingSecret !== undefined) {
    const signed = await buildStewardSignedHeaders({
      method: "DELETE",
      path,
      body: "",
      tenantId: stewardTenant.tenantId,
      ...(platformKey === undefined ? {} : { platformKey }),
      signingSecret,
    });
    for (const [name, value] of Object.entries(signed)) {
      flags.push(`-H ${shellQuote(`${name}: ${value}`)}`);
    }
  }
  return `curl -s -X DELETE ${flags.join(" ")} ${shellQuote(url)} || true`;
}

async function buildStewardSignedHeaders(params: {
  method: string;
  path: string;
  body: string;
  tenantId: string;
  platformKey?: string;
  signingSecret: string;
}): Promise<Record<string, string>> {
  const headers = new Headers();
  headers.set("X-Steward-Tenant", params.tenantId);
  if (params.platformKey) {
    headers.set("X-Steward-Platform-Key", params.platformKey);
  }
  await signStewardMutatingRequest(
    params.signingSecret,
    params.method,
    params.path,
    headers,
    new TextEncoder().encode(params.body),
  );
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    // Strip tenant/platform-key — the caller injects them via curl flag or
    // Python shim. Avoid double-injection.
    if (name === "x-steward-tenant" || name === "x-steward-platform-key") {
      return;
    }
    out[name] = value;
  });
  return out;
}

async function registerAgentWithSteward(
  ssh: DockerSSHClient,
  agentId: string,
  agentName: string,
  tenantId: string,
  apiKey?: string,
): Promise<string> {
  // The legacy tenant-scoped POST /agents route requires a session-jwt with
  // owner|admin role (Steward `requireTenantAdminSession`), which a daemon
  // cannot satisfy. Switch to the platform-key path Steward exposes for
  // exactly this use-case: POST /platform/tenants/:id/agents (scope
  // `platform:agent:create`) and POST /platform/tenants/:id/agents/:id/token
  // (scope `platform:agent-token:create`). The tenant `apiKey` argument is
  // kept only for backwards-compat — we now authenticate via
  // STEWARD_PLATFORM_KEY.
  warnMissingStewardTenantApiKey(apiKey);
  const platformKey = resolveStewardPlatformKey();
  const agentBody = JSON.stringify({ id: agentId, name: agentName });
  // Steward caps agent-token expiry at 7d (validated in
  // packages/api/src/routes/platform.ts — "expiresIn must be a duration up
  // to 7d using s, m, h, or d"). The daemon refreshes agent JWTs via the
  // STEWARD_REFRESH_URL flow before they expire, so a 7d ceiling is fine.
  const tokenBody = JSON.stringify({ expiresIn: "7d" });
  const signingSecret = resolveStewardRequestSigningSecret(apiKey);
  const agentPath = buildPlatformAgentPath(tenantId);
  const tokenPath = `${buildPlatformAgentPath(tenantId, agentId)}/token`;
  const agentSignedHeaders =
    signingSecret === undefined
      ? {}
      : await buildStewardSignedHeaders({
          method: "POST",
          path: agentPath,
          body: agentBody,
          tenantId,
          ...(platformKey === undefined ? {} : { platformKey }),
          signingSecret,
        });
  const tokenSignedHeaders =
    signingSecret === undefined
      ? {}
      : await buildStewardSignedHeaders({
          method: "POST",
          path: tokenPath,
          body: tokenBody,
          tenantId,
          ...(platformKey === undefined ? {} : { platformKey }),
          signingSecret,
        });

  const script = `python3 - <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url = ${JSON.stringify(resolveStewardHostUrl())}
platform_key = ${JSON.stringify(platformKey ?? "")}
tenant_id = ${JSON.stringify(tenantId)}
agent_path = ${JSON.stringify(agentPath)}
token_path = ${JSON.stringify(tokenPath)}
agent_body = ${JSON.stringify(agentBody)}
token_body = ${JSON.stringify(tokenBody)}
agent_signed_headers = ${JSON.stringify(agentSignedHeaders)}
token_signed_headers = ${JSON.stringify(tokenSignedHeaders)}


def post(path, body_text, signed_headers):
    headers = {"Content-Type": "application/json", "User-Agent": "eliza-cloud-provisioner/1.0"}
    if tenant_id:
        headers["X-Steward-Tenant"] = tenant_id
    if platform_key:
        headers["X-Steward-Platform-Key"] = platform_key
    headers.update(signed_headers)
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=body_text.encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


status, body = post(agent_path, agent_body, agent_signed_headers)
if status not in (200, 201, 202, 400, 409):
    print(body, file=sys.stderr)
    raise SystemExit(f"Steward agent registration failed with status {status}")
# 400/409 = agent already exists, continue to token minting

status, body = post(token_path, token_body, token_signed_headers)
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
    const { agentId, agentName, environmentVars, organizationId, agentConfig, routeAgentId } =
      config;

    // Resolve Docker image: per-agent DB override > operator env override > hardcoded default.
    // Keep the fallback out of DOCKER_IMAGE_OVERRIDE so per-agent flavor/image
    // overrides are not accidentally shadowed by the generic Eliza default.
    const resolvedImage = resolveDockerSandboxImage(config.dockerImage);
    const imagePlatform = containersEnv.defaultAgentImagePlatform();
    const platformFlags = dockerPlatformFlag(imagePlatform);
    const containerPort = resolveContainerPort(config);
    const healthCheckPath = config.container?.healthCheckPath ?? "/api/health";

    // 1. Input validation
    validateAgentName(agentName);
    validateAgentId(agentId);

    const cloudEnv = getCloudAwareEnv();
    const env: HeadscaleRouteEnv = {
      AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: cloudEnv.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK,
      CONTAINERS_PUBLIC_BASE_DOMAIN: cloudEnv.CONTAINERS_PUBLIC_BASE_DOMAIN,
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: cloudEnv.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
      ENVIRONMENT: cloudEnv.ENVIRONMENT,
      HEADSCALE_API_KEY: cloudEnv.HEADSCALE_API_KEY,
      HEADSCALE_API_URL: cloudEnv.HEADSCALE_API_URL,
      HEADSCALE_PUBLIC_URL: cloudEnv.HEADSCALE_PUBLIC_URL,
    };
    // Pass the same snapshot to requiresHeadscaleRoute so that both the
    // HEADSCALE_API_KEY presence check and the route-required decision read
    // from one consistent view of the environment.
    const headscaleRouteRequired = requiresHeadscaleRoute(env);
    const headscaleEnabled = !!env.HEADSCALE_API_KEY?.trim();
    if (headscaleRouteRequired && !headscaleEnabled) {
      const errorMessage =
        "Headscale routing is required for this cloud environment, but HEADSCALE_API_KEY is not configured. " +
        "Refusing to mark the agent running without a routable internal ingress; " +
        "set AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK=1 only for legacy public-host routing.";
      logger.error(`[docker-sandbox] ${errorMessage}`, {
        agentId,
      });
      throw new Error(errorMessage);
    }

    // 2. Select target node via DockerNodeManager (least-loaded, DB-backed).
    // getAvailableNode + incrementAllocated + getUsedDockerHostPorts are three sequential
    // DB round-trips without a transaction boundary; the UNIQUE port index and
    // retry logic provide safety against concurrent capacity changes.
    let dbNode = await dockerNodeManager.getAvailableNode({
      requiredPlatform: imagePlatform,
      excludeNodeId: config.excludeNodeId,
    });
    if (!dbNode) {
      dbNode = await this.provisionAutoscaledNodeForAgent({
        image: resolvedImage,
        platform: imagePlatform,
      });
    }

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
      const allEnvNodes = parseDockerNodes();
      const envNodes = config.excludeNodeId
        ? allEnvNodes.filter((n) => n.nodeId !== config.excludeNodeId)
        : allEnvNodes;
      if (envNodes.length === 0) {
        throw new Error(
          `[docker-sandbox] No nodes available (excludeNodeId=${config.excludeNodeId ?? "none"} filtered out all seed nodes)`,
        );
      }
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
    // Auto-provision the Steward tenant for this org if it doesn't have one
    // yet. Without this step, fresh organizations fall through to
    // `DEFAULT_STEWARD_TENANT_ID` ("elizacloud") — and if that default tenant
    // hasn't been pre-created on the Steward backend, `registerAgentWithSteward`
    // below fails with "Steward agent registration failed with status 404",
    // surfacing as "CLOUD CONNECTION NEEDS ATTENTION" in the desktop UI for
    // every newly-signed-in user. When `STEWARD_PLATFORM_KEYS` is not
    // configured (non-prod environments) this is a no-op that leaves the
    // legacy fallback behavior intact.
    const stewardTenant = organizationId
      ? await ensureStewardTenant(organizationId)
      : await resolveStewardTenantCredentials({ organizationId });

    // 4. Optionally prepare Headscale VPN
    let headscaleIp: string | null = null;

    // Collect VPN env vars separately to avoid mutating the caller's environmentVars
    let vpnEnvVars: Record<string, string> = {};
    if (headscaleEnabled) {
      try {
        const vpnSetup = await headscaleIntegration.prepareContainerVPN({
          agentId,
          agentName,
          organizationId,
        });
        vpnEnvVars = vpnSetup.envVars;
        logger.info(`[docker-sandbox] Headscale VPN enabled for ${agentId}`);
      } catch (err) {
        if (headscaleRouteRequired) {
          if (dbNode) {
            await dockerNodesRepository.decrementAllocated(nodeId).catch((rollbackErr) => {
              logger.warn(
                `[docker-sandbox] Failed to decrement allocated_count after Headscale preparation failure for node ${nodeId}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
              );
            });
          }
          throw err;
        }
        logger.warn(
          `[docker-sandbox] Headscale VPN preparation failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Continue without VPN — not a critical failure
      }
    }

    // 5. Build the base environment (spread to avoid mutating caller's environmentVars)
    const stewardContainerUrl = resolveStewardContainerEnvUrl();
    const proxyEnv = buildStewardProxyEnv();

    // Propagate the orchestrator's KMS configuration into the container so
    // field-level encryption (per-agent Neon DB) uses the same backend + root
    // key on both ends. Without this the container's resolveKmsBackend() falls
    // through to the `steward` default and crashes at boot when no steward
    // config is present:
    //   "ELIZA_KMS_BACKEND=steward requires steward.{baseUrl, tokenProvider}"
    // which times out the sandbox health check and fails provisioning. The
    // daemon already requires a usable KMS, so inheriting its backend + root
    // key keeps the fleet consistent. Spread before `...environmentVars` so an
    // explicit per-agent override still wins. See elizaOS/eliza#8062.
    const kmsEnv: Record<string, string> = {};
    {
      const isKmsBackend = (v: string | undefined): v is string =>
        v === "memory" || v === "local" || v === "steward";
      const declared = environmentVars.ELIZA_KMS_BACKEND?.trim();
      const inherited = process.env.ELIZA_KMS_BACKEND?.trim();
      const backend = isKmsBackend(declared)
        ? declared
        : isKmsBackend(inherited)
          ? inherited
          : "local";
      kmsEnv.ELIZA_KMS_BACKEND = backend;
      if (backend === "local") {
        const rootKey =
          environmentVars.ELIZA_LOCAL_ROOT_KEY?.trim() || process.env.ELIZA_LOCAL_ROOT_KEY?.trim();
        if (rootKey) kmsEnv.ELIZA_LOCAL_ROOT_KEY = rootKey;
      }
    }

    const baseEnv: Record<string, string> = {
      ...kmsEnv,
      ...environmentVars,
      ...vpnEnvVars,
      ...proxyEnv,
      AGENT_NAME: agentName,
      ELIZA_CLOUD_PROVISIONED: "1",
      // Path A: inject the character so the container boots AS this agent
      // (e.g. "Nyx") instead of the bundled default "Eliza" preset. Consumed
      // by packages/agent/src/runtime/sandbox-character.ts. Secret-bearing
      // fields (connector tokens, secrets, settings.secrets) are redacted
      // first — the runtime receives connector tokens via dedicated env vars
      // (DISCORD_API_TOKEN, TELEGRAM_BOT_TOKEN) and never needs them embedded
      // in the character JSON, which would otherwise be visible via
      // /proc/<pid>/environ and crash diagnostics. Omitted when the caller has
      // no agent_config (the runtime keeps its default-character behaviour).
      ...(agentConfig && typeof agentConfig === "object"
        ? {
            ELIZA_AGENT_CHARACTER_JSON: JSON.stringify(redactCharacterSecrets(agentConfig)),
          }
        : {}),
      STEWARD_API_URL: stewardContainerUrl,
      STEWARD_AGENT_ID: agentId,
      // V2 image binds the eliza-api server to ELIZA_PORT, not PORT. Keep both
      // aligned to the requested app port so the daemon's HTTP probe (which hits
      // the host port mapped to container PORT) reaches the actual listener.
      ELIZA_PORT: containerPort,
      PORT: containerPort,
      BRIDGE_PORT: DEFAULT_BRIDGE_PORT,
      // Eliza server requires JWT_SECRET in production mode.
      // Generate a unique per-container secret if the caller didn't provide one.
      JWT_SECRET: environmentVars.JWT_SECRET || crypto.randomUUID(),
      // Allow the agent subdomain origin so the browser can call the API.
      ELIZA_ALLOWED_ORIGINS: `https://${agentId}.${getAgentBaseDomain()}`,
      // Shared service-to-service secret the cloud gateways attach as the
      // X-Server-Token header when they forward inbound platform messages to
      // this container's /agents/:id/message endpoint. The container's auth
      // path (packages/agent server-helpers-auth isAuthorized) accepts this
      // header when it matches, so a gateway can route a message without
      // knowing the per-agent inbound API token. Sourced from the daemon's own
      // AGENT_SERVER_SHARED_SECRET (the same value the gateways read); both
      // ends must share it. An explicit per-deployment value in
      // environmentVars wins. Omitted entirely when neither is set, which
      // simply leaves the X-Server-Token path disabled in the container.
      ...resolveServerSharedSecretEnv(environmentVars),
    };

    // 6. SSH to node, ensure volume dir, pull image, register in Steward,
    // then create/start the container. Pass hostKeyFingerprint so pooled
    // clients pin the key when available.
    const ssh = DockerSSHClient.getClient(hostname, sshPort, hostKeyFingerprint, sshUser);

    try {
      // Ensure volume directory exists
      await ssh.exec(
        `mkdir -p ${shellQuote(volumePath)} ${shellQuote(`${volumePath}/eliza`)}`,
        DOCKER_CMD_TIMEOUT_MS,
      );

      // Pull image (may take a while on first run)
      logger.info(`[docker-sandbox] Pulling image ${resolvedImage} on ${nodeId}`);
      try {
        await ssh.exec(
          ["docker pull", ...platformFlags, shellQuote(resolvedImage)].join(" "),
          PULL_TIMEOUT_MS,
        );
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

      // Pass the shared Upstash credentials through to the sandbox so it can
      // self-register `agent:<id>:server` + `server:<name>:url` keys that
      // gateway-discord / gateway-webhook resolve for inbound platform
      // messages. Omit when the orchestrator env doesn't carry them — the
      // sandbox will skip registration silently in that case.
      const registryRedisUrl = process.env.KV_REST_API_URL?.trim() ?? "";
      const registryRedisToken = process.env.KV_REST_API_TOKEN?.trim() ?? "";
      const canSelfRegister = registryRedisUrl !== "" && registryRedisToken !== "";
      if (!canSelfRegister) {
        logger.warn(
          "[docker-sandbox] KV_REST_API_URL / KV_REST_API_TOKEN missing from orchestrator env — sandbox will not register in Redis and gateways will not route inbound platform messages to it",
        );
      }

      const stewardJwt = isAgentTokenSigningConfigured()
        ? (await mintAgentToken(agentId, 900)).token
        : "";
      const stewardRefreshServiceToken = resolveStewardRefreshServiceToken();
      if (!stewardJwt) {
        logger.warn(
          "[docker-sandbox] AGENT_TOKEN_PRIVATE_KEY_PEM not configured — skipping STEWARD_JWT injection for Steward agent JWT auth",
        );
      }

      const allEnv: Record<string, string> = {
        ...baseEnv,
        STEWARD_AGENT_TOKEN: stewardAgentToken,
        ...(stewardJwt
          ? {
              STEWARD_JWT: stewardJwt,
              STEWARD_JWT_FILE,
              STEWARD_REFRESH_URL: resolveStewardRefreshUrl(),
              ...(stewardRefreshServiceToken
                ? { STEWARD_REFRESH_SERVICE_TOKEN: stewardRefreshServiceToken }
                : {}),
            }
          : {}),
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
        // V2 image refuses to boot on headless Linux without a passphrase
        // (no D-Bus keychain). Generate one per container — the vault state
        // lives only in the per-container PGlite, so a unique per-launch key
        // is fine.
        ELIZA_VAULT_PASSPHRASE: environmentVars.ELIZA_VAULT_PASSPHRASE || crypto.randomUUID(),
        // Gateway service discovery — see SandboxRegistry in app-core.
        // SANDBOX_PUBLIC_URL targets the public Docker host (not the headscale
        // VPN IP set later at line ~653) because the gateways on Railway can't
        // route through Hetzner's private VPN.
        ...(canSelfRegister
          ? {
              SANDBOX_REGISTRY_REDIS_URL: registryRedisUrl,
              SANDBOX_REGISTRY_REDIS_TOKEN: registryRedisToken,
              SANDBOX_AGENT_ID: agentId,
              // The gateways route by the platform character_id, so the
              // container must register under (and answer as) that id, not
              // the sandbox id. Injected only when the caller provides it.
              ...(routeAgentId?.trim() ? { SANDBOX_ROUTE_AGENT_ID: routeAgentId.trim() } : {}),
              SANDBOX_SERVER_NAME: `sandbox-${agentId}-${crypto.randomUUID()}`,
              SANDBOX_PUBLIC_URL: `http://${hostname}:${bridgePort}/api`,
            }
          : {}),
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
        ...platformFlags,
        `--name ${shellQuote(containerName)}`,
        "--restart unless-stopped",
        `--network ${shellQuote(DOCKER_NETWORK)}`,
        ...(requiresDockerHostGateway(stewardContainerUrl) || Object.keys(proxyEnv).length > 0
          ? ["--add-host host.docker.internal:host-gateway"]
          : []),
        `--health-cmd ${shellQuote(getDockerHealthCmd(allEnv.PORT || containerPort, healthCheckPath))}`,
        "--health-interval 10s",
        "--health-timeout 5s",
        "--health-start-period 15s",
        "--health-retries 6",
        ...(config.container?.memoryMb
          ? [`--memory ${shellQuote(`${Math.ceil(config.container.memoryMb)}m`)}`]
          : []),
        ...(headscaleEnabled ? ["--cap-add=NET_ADMIN", "--device /dev/net/tun"] : []),
        `-v ${shellQuote(volumePath)}:/app/data`,
        `-v ${shellQuote(`${volumePath}/eliza`)}:/root/.eliza`,
        // The cloud image serves both API and web UI from PORT (default 3000).
        // Publish both externally allocated host ports to that live listener so
        // nginx can reach /api/* via bridge_url and the UI via web_ui_port.
        `-p ${bridgePort}:${allEnv.PORT || DEFAULT_AGENT_PORT}`,
        `-p ${webUiPort}:${allEnv.PORT || DEFAULT_AGENT_PORT}`,
        envFlags,
        shellQuote(resolvedImage),
      ].join(" ");

      // Self-heal nodes missing the shared bridge network (Robot cores never
      // run the cloud-init bootstrap; the network can also be pruned away).
      // Without this, `docker create --network` below fails with an opaque
      // "network not found" and the provision retries forever.
      await ssh.exec(buildEnsureNetworkCmd(DOCKER_NETWORK), DOCKER_CMD_TIMEOUT_MS);

      const containerId = extractDockerCreateContainerId(
        await ssh.exec(dockerCreateCmd, DOCKER_CMD_TIMEOUT_MS),
      );
      await ssh.exec(`docker start ${shellQuote(containerName)}`, DOCKER_CMD_TIMEOUT_MS);
      logger.info(
        `[docker-sandbox] Container created on ${nodeId}: ${containerId} (${containerName})`,
      );

      if (shouldInstallStewardPlugin(agentId, environmentVars)) {
        try {
          await ssh.exec(buildStewardPluginInstallCommand(containerName), PULL_TIMEOUT_MS);
          logger.info(`[docker-sandbox] Steward Eliza plugin installed in ${containerName}`);
        } catch (pluginErr) {
          logger.warn(
            `[docker-sandbox] Failed to install Steward Eliza plugin in ${containerName}: ${pluginErr instanceof Error ? pluginErr.message : String(pluginErr)}`,
          );
        }
      }

      if (stewardJwt && stewardRefreshServiceToken) {
        try {
          await ssh.exec(
            buildStewardRefreshCommand(containerName, agentId, stewardRefreshServiceToken),
            DOCKER_CMD_TIMEOUT_MS,
          );
          logger.info(`[docker-sandbox] Steward JWT refresh sidecar started in ${containerName}`);
        } catch (refreshErr) {
          logger.warn(
            `[docker-sandbox] Failed to start Steward JWT refresh sidecar in ${containerName}: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
          );
        }
      }

      // Write ~/.eliza/eliza.json so the runtime sees cloud config even if
      // it bypasses env vars. Best-effort: a failure here is logged but
      // does not abort provisioning — the env vars on the container still
      // carry the same values.
      try {
        if (!allEnv.ELIZAOS_CLOUD_BASE_URL) {
          throw new Error(
            "[docker-sandbox] ELIZAOS_CLOUD_BASE_URL is not set in container env. " +
              "Refusing to fall back to the hardcoded prod URL (https://www.elizacloud.ai/api/v1) — " +
              "this caused staging containers to silently call prod. " +
              "Configure ELIZAOS_CLOUD_BASE_URL in the daemon/Worker env (e.g. " +
              "https://api-staging.elizacloud.ai/api/v1 for staging, https://api.elizacloud.ai/api/v1 for prod).",
          );
        }
        const elizaConfig = JSON.stringify({
          logging: { level: "info" },
          cloud: {
            enabled: Boolean(allEnv.ELIZAOS_CLOUD_API_KEY),
            apiKey: allEnv.ELIZAOS_CLOUD_API_KEY || "",
            baseUrl: allEnv.ELIZAOS_CLOUD_BASE_URL,
          },
        });
        // Base64-encode the JSON before passing it through the shell so an
        // apiKey/baseUrl containing single quotes can't break out of the
        // outer sh -c quoting or inject commands on the remote host.
        const encodedConfig = Buffer.from(elizaConfig, "utf-8").toString("base64");
        const writeCmd = `docker exec ${shellQuote(containerName)} sh -c ${shellQuote(
          `mkdir -p /root/.eliza && printf %s ${shellQuote(encodedConfig)} | base64 -d > /root/.eliza/eliza.json`,
        )}`;
        await ssh.exec(writeCmd, DOCKER_CMD_TIMEOUT_MS);
        logger.info(`[docker-sandbox] Cloud config written to eliza.json in ${containerName}`);
      } catch (configErr) {
        logger.warn(
          `[docker-sandbox] Failed to write eliza.json: ${configErr instanceof Error ? configErr.message : String(configErr)}`,
        );
      }
    } catch (err) {
      // Best-effort Steward deregistration — the agent was registered but the
      // container failed to start, so we try to clean up the Steward record.
      try {
        await ssh.exec(
          await buildSignedDeleteAgentCurl(agentId, stewardTenant),
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
        await headscaleIntegration.cleanupContainerVPN(vpnEnvVars.TS_HOSTNAME ?? agentId).catch((cleanupErr) => {
          logger.warn(
            `[docker-sandbox] Headscale cleanup failed during rollback for ${agentId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        });
      }
      throw new Error(
        `[docker-sandbox] Failed to create container on ${nodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const meta: ContainerMeta = {
      nodeId,
      hostname,
      containerName,
      bridgePort,
      webUiPort,
      agentId,
      // Headscale node name (TS_HOSTNAME) the container registered under, so
      // cleanup can find + delete the node by the same name it was created with.
      tsHostname: vpnEnvVars.TS_HOSTNAME,
      sshPort,
      sshUser,
      hostKeyFingerprint,
    };
    this.containers.set(containerName, meta);

    // 8. Wait for Headscale VPN registration if enabled
    if (headscaleEnabled) {
      try {
        // Poll by the node's TS_HOSTNAME (what the container registers under via
        // inferTailscaleHostname), NOT the bare agentId — Headscale only knows the
        // node by that hostname, so polling by agentId never matched and the node
        // "timed out" registering despite being online.
        headscaleIp = await headscaleIntegration.waitForVPNRegistration(
          vpnEnvVars.TS_HOSTNAME ?? agentId,
          60_000,
        );
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

    if (headscaleRouteRequired && !headscaleIp) {
      const errorMessage =
        "Headscale routing is required, but the sandbox did not register a headscale_ip. " +
        "Refusing to mark the agent running without a routable internal ingress; " +
        "set AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK=1 only for legacy public-host routing.";
      logger.error(`[docker-sandbox] ${errorMessage}`, {
        agentId,
        containerName,
        nodeId,
      });
      await ssh
        .exec(await buildSignedDeleteAgentCurl(agentId, stewardTenant), DOCKER_CMD_TIMEOUT_MS)
        .then(() => {
          logger.info(
            `[docker-sandbox] Cleaned up Steward agent ${agentId} after missing Headscale registration`,
          );
        })
        .catch((cleanupErr) => {
          logger.warn(
            `[docker-sandbox] Failed to cleanup Steward agent ${agentId} after missing Headscale registration: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        });
      await this.stop(containerName).catch((cleanupErr) => {
        const cleanupMessage =
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        logger.warn(
          `[docker-sandbox] Cleanup after missing Headscale registration failed for ${containerName}: ${cleanupMessage}`,
        );
      });
      throw new Error(errorMessage);
    }

    // 10. Return handle with strongly-typed metadata
    const targetHost = headscaleIp || hostname;

    // Probe ghcr.io for the image's current digest so the fleet-upgrade
    // reconciler can detect when the tag has been republished. Returns null
    // on bare image names or registry errors — both are treated as
    // "unknown, leave alone" by the reconciler.
    const imageDigest = await resolveImageDigest(resolvedImage);

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
      imageDigest,
      headscaleIp: headscaleIp || undefined,
    };

    return {
      sandboxId: containerName,
      bridgeUrl: `http://${targetHost}:${bridgePort}`,
      healthUrl: `http://${targetHost}:${webUiPort}/api`,
      metadata: { ...metadata },
    };
  }

  private async provisionAutoscaledNodeForAgent({
    image,
    platform,
  }: {
    image: string;
    platform?: string;
  }): Promise<DockerNode | null> {
    const env = getCloudAwareEnv();
    const hcloudToken = containersEnv.hetznerCloudToken();
    const publicKey = env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY?.trim();
    if (!hcloudToken || !publicKey) {
      logger.warn("[docker-sandbox] No Docker capacity and autoscale is not configured", {
        hasHcloudToken: Boolean(hcloudToken),
        hasPublicKey: Boolean(publicKey),
      });
      return null;
    }

    try {
      logger.info("[docker-sandbox] No reachable Docker capacity; provisioning autoscaled node", {
        image,
        platform,
      });
      const provisioned = await getNodeAutoscaler().provisionNode(
        {
          prePullImages: [image],
          labels: { purpose: "agent-provisioning" },
        },
        {
          controlPlanePublicKey: publicKey,
          registrationUrl: env.CONTAINERS_BOOTSTRAP_CALLBACK_URL,
          registrationSecret: env.CONTAINERS_BOOTSTRAP_SECRET,
        },
      );

      const deadline = Date.now() + AUTOSCALED_NODE_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const node = await dockerNodesRepository.findByNodeId(provisioned.nodeId);
        if (
          node &&
          (await dockerNodeManager.ensureNodeReady(node, {
            requiredPlatform: platform,
          }))
        ) {
          logger.info("[docker-sandbox] Autoscaled Docker node is ready", {
            nodeId: node.node_id,
            hostname: node.hostname,
          });
          return node;
        }
        await new Promise((resolve) => setTimeout(resolve, AUTOSCALED_NODE_READY_POLL_MS));
      }

      logger.warn("[docker-sandbox] Autoscaled Docker node did not become ready before timeout", {
        nodeId: provisioned.nodeId,
        hostname: provisioned.hostname,
      });
      return null;
    } catch (error) {
      logger.warn("[docker-sandbox] Autoscaled Docker node provisioning failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // ------------------------------------------------------------------
  // stop
  // ------------------------------------------------------------------

  /**
   * Stop and remove a container on a specific node using explicit node info.
   * Used by the fleet-upgrade handler to tear down the old container AFTER
   * the blue/green swap has already updated the agent_sandboxes row to point
   * at the blue — at which point `this.containers` and the DB both resolve
   * to the blue, so the regular `stop(sandboxId)` would target the wrong
   * container.
   *
   * Best-effort: a swap that already redirected traffic doesn't break if we
   * leave a zombie on the old node; the next reconciliation pass plus the
   * autoscaler's idle-node drain handle eventual cleanup. We still try
   * stop+rm with graceful drain so users on websockets get a SIGTERM rather
   * than an abrupt kill.
   */
  async stopOnSpecificNode(
    node: DockerNode,
    containerName: string,
    gracefulSeconds = 30,
  ): Promise<void> {
    const ssh = DockerSSHClient.getClient(
      node.hostname,
      node.ssh_port ?? DEFAULT_SSH_PORT,
      node.host_key_fingerprint ?? undefined,
      node.ssh_user ?? DEFAULT_SSH_USERNAME,
    );
    let stopErr: unknown;
    let rmErr: unknown;
    try {
      await ssh.exec(
        `docker stop -t ${gracefulSeconds} ${shellQuote(containerName)}`,
        DOCKER_CMD_TIMEOUT_MS,
      );
    } catch (err) {
      stopErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isAlreadyGoneMessage(msg)) {
        logger.warn(
          `[docker-sandbox] stopOnSpecificNode: docker stop failed for ${containerName} on ${node.node_id}: ${msg}`,
        );
      }
    }
    try {
      await ssh.exec(`docker rm -f ${shellQuote(containerName)}`, DOCKER_CMD_TIMEOUT_MS);
    } catch (err) {
      rmErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isAlreadyGoneMessage(msg)) {
        logger.warn(
          `[docker-sandbox] stopOnSpecificNode: docker rm -f failed for ${containerName} on ${node.node_id}: ${msg}`,
        );
      }
    }

    // Only decrement allocated_count when we have evidence the container is
    // actually gone: at least one call landed, or one reported "already gone".
    // If BOTH calls failed for a non-already-gone reason (SSH down, daemon
    // hung), the container may still be running on the node — decrementing
    // would under-count and let the scheduler over-place onto this node.
    // Mirrors the escalation guard in stop(), but stays best-effort (no throw)
    // because traffic has already been redirected to the new container.
    if (stopErr && rmErr) {
      const stopMsg = stopErr instanceof Error ? stopErr.message : String(stopErr);
      const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr);
      if (!isAlreadyGoneMessage(stopMsg) && !isAlreadyGoneMessage(rmMsg)) {
        logger.warn(
          `[docker-sandbox] stopOnSpecificNode: both stop and rm failed for ${containerName} on ${node.node_id}; leaving allocated_count intact (possible zombie) — stop -> ${stopMsg}; rm -> ${rmMsg}`,
        );
        return;
      }
    }

    await dockerNodesRepository.decrementAllocated(node.node_id).catch((err) => {
      logger.warn(
        `[docker-sandbox] stopOnSpecificNode: decrement allocated_count failed for ${node.node_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

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

    // Track both attempts so we can fail loudly if neither call landed.
    // Historically these errors were swallowed independently, which let
    // the caller think a delete succeeded while the container kept
    // running on the core (observed in prod e2e on 2026-05-16). We need
    // at least one of (stop, rm) to land for the container to be
    // effectively gone.
    let stopErr: unknown;
    let rmErr: unknown;

    try {
      // Graceful stop with 10s timeout, then force-remove
      await ssh.exec(`docker stop -t 10 ${shellQuote(meta.containerName)}`, DOCKER_CMD_TIMEOUT_MS);
      logger.info(`[docker-sandbox] Container stopped: ${meta.containerName}`);
    } catch (err) {
      stopErr = err;
      logger.warn(
        `[docker-sandbox] docker stop failed for ${meta.containerName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await ssh.exec(`docker rm -f ${shellQuote(meta.containerName)}`, DOCKER_CMD_TIMEOUT_MS);
      logger.info(`[docker-sandbox] Container removed: ${meta.containerName}`);
    } catch (err) {
      rmErr = err;
      logger.error(
        `[docker-sandbox] docker rm failed for ${meta.containerName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (stopErr && rmErr) {
      const stopMsg = stopErr instanceof Error ? stopErr.message : String(stopErr);
      const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr);
      // "No such container" from either call means the container was
      // already gone — that is a success, not a failure. We only escalate
      // when both calls failed for a reason that does NOT indicate the
      // container is absent (SSH down, Docker daemon hung, etc.).
      const stopIsGone = isAlreadyGoneMessage(stopMsg);
      const rmIsGone = isAlreadyGoneMessage(rmMsg);
      if (!stopIsGone && !rmIsGone) {
        throw new Error(
          `Failed to stop container ${meta.containerName} on ${meta.hostname}: ` +
            `docker stop -> ${stopMsg}; docker rm -f -> ${rmMsg}`,
        );
      }
      logger.info(
        `[docker-sandbox] Container ${meta.containerName} already absent on ${meta.hostname}`,
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
      // Delete the node by the hostname it registered under (TS_HOSTNAME), not the
      // bare agentId — Headscale identifies the node by that name.
      await headscaleIntegration.cleanupContainerVPN(meta.tsHostname ?? meta.agentId).catch((err) => {
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
    const hostProbeCmd = `sh -lc ${shellQuote(
      [
        `for URL in http://127.0.0.1:${meta.bridgePort}/api/health http://127.0.0.1:${meta.webUiPort}/; do`,
        `STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null || true);`,
        `case "$STATUS" in 200|301|302|401) exit 0;; esac;`,
        `done; exit 1`,
      ].join(" "),
    )}`;

    logger.info(
      `[docker-sandbox] Polling Docker health for ${meta.containerName} on ${meta.nodeId} (${meta.hostname}) (timeout: ${HEALTH_CHECK_TIMEOUT_MS / 1000}s)`,
    );

    while (Date.now() < deadline) {
      try {
        await ssh.exec(hostProbeCmd, Math.min(10_000, HEALTH_CHECK_TIMEOUT_MS));
        logger.info(
          `[docker-sandbox] Host HTTP probe passed for ${meta.containerName} on ${meta.nodeId}`,
        );
        return true;
      } catch (err) {
        logger.debug(
          `[docker-sandbox] Host HTTP probe failed for ${meta.containerName}, retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

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
    try {
      const diagnostics = await ssh.exec(
        [
          `echo '--- inspect ---'`,
          `docker inspect --format 'state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} exit={{.State.ExitCode}} error={{.State.Error}}' ${shellQuote(meta.containerName)} || true`,
          `echo '--- ports ---'`,
          `docker port ${shellQuote(meta.containerName)} || true`,
          `echo '--- logs ---'`,
          `docker logs --tail 160 ${shellQuote(meta.containerName)} 2>&1 || true`,
        ].join("; "),
        DOCKER_CMD_TIMEOUT_MS,
      );
      logger.warn("[docker-sandbox] Health timeout diagnostics", {
        containerName: meta.containerName,
        nodeId: meta.nodeId,
        diagnostics: diagnostics.slice(-12_000),
      });
    } catch (diagnosticsError) {
      logger.warn("[docker-sandbox] Failed to collect health timeout diagnostics", {
        containerName: meta.containerName,
        error:
          diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError),
      });
    }
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

  /**
   * SSH `docker logs --tail N <container>` on the assigned core and
   * return the combined stdout/stderr. Used by the `agent_logs` job
   * type so the cloud-api Worker doesn't have to reach the container
   * bridge HTTP endpoint (which is unreachable for stopped/crashed
   * agents).
   */
  async fetchLogs(sandboxId: string, tail: number): Promise<string> {
    const meta = await this.resolveContainer(sandboxId);

    const safeTail = Math.max(1, Math.min(Math.floor(tail), 5000));

    const ssh = DockerSSHClient.getClient(
      meta.hostname,
      meta.sshPort,
      meta.hostKeyFingerprint,
      meta.sshUser,
    );
    // `2>&1` merges stderr so the user sees boot errors when an agent
    // is crash-looping — agents in node tend to write the interesting
    // failure traces to stderr.
    return await ssh.exec(
      `docker logs --tail ${safeTail} ${shellQuote(meta.containerName)} 2>&1`,
      DOCKER_CMD_TIMEOUT_MS,
    );
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
