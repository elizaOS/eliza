/**
 * Container service env var resolution.
 *
 * Single source of truth for env vars consumed by the Hetzner-Docker
 * container control plane. Reads the canonical `CONTAINERS_*` /
 * `ELIZA_AGENT_*` names first and falls back to the legacy `AGENT_*`
 * names so existing deployments keep working during the rebrand.
 *
 * Add new env reads here, not at call sites.
 */

import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

function normalizeEnvValue(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\n$/g, "")
    .trim();
}

function pick(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeEnvValue(candidate);
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

export const containersEnv = {
  /** Base64-encoded SSH private key for connecting to Docker nodes. */
  sshKey(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_SSH_KEY, env.AGENT_SSH_KEY);
  },

  /** Filesystem path to the SSH private key (used when sshKey() is unset). */
  sshKeyPath(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_SSH_KEY_PATH, env.AGENT_SSH_KEY_PATH);
  },

  /** SSH user for connecting to Docker nodes. Defaults to "root". */
  sshUser(): string {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_SSH_USER, env.AGENT_SSH_USER, env.MILADY_SSH_USER) ?? "root";
  },

  /** Docker network name created on every node. Containers attach to this. */
  dockerNetwork(): string {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_DOCKER_NETWORK, env.AGENT_DOCKER_NETWORK) ?? "containers-isolated";
  },

  /** Username used for Docker registry pulls on container nodes. */
  registryUsername(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(
      env.CONTAINERS_REGISTRY_USERNAME,
      env.ELIZA_APP_IMAGE_REGISTRY_USERNAME,
      env.GHCR_USERNAME,
      env.GITHUB_ACTOR,
    );
  },

  /** Token used for Docker registry pulls on container nodes. */
  registryToken(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(
      env.CONTAINERS_REGISTRY_TOKEN,
      env.ELIZA_APP_IMAGE_REGISTRY_TOKEN,
      env.GHCR_TOKEN,
      env.GITHUB_TOKEN,
      env.GH_TOKEN,
      env.CR_PAT,
    );
  },

  /** Filesystem path to a Docker registry token for container node pulls. */
  registryTokenFile(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_REGISTRY_TOKEN_FILE, env.ELIZA_APP_IMAGE_REGISTRY_TOKEN_FILE);
  },

  /**
   * Default agent image when a caller asks for the canonical Eliza agent
   * flavor without specifying a tag. Operators can pin a specific tag here
   * without code changes.
   */
  defaultAgentImage(): string {
    return this.defaultAgentImageOverride() ?? "ghcr.io/elizaos/eliza:latest";
  },

  /** Explicit operator-pinned agent image, without the hardcoded fallback. */
  defaultAgentImageOverride(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(
      env.ELIZA_AGENT_IMAGE,
      env.CONTAINERS_DEFAULT_IMAGE,
      env.AGENT_DOCKER_IMAGE,
      env.MILADY_DOCKER_IMAGE,
    );
  },

  /**
   * Platform for the canonical managed-agent image. The current production
   * image is amd64-only, so autoscaled nodes must be x86 unless operators
   * explicitly publish/configure a multi-arch image.
   */
  defaultAgentImagePlatform(): string | undefined {
    const env = getCloudAwareEnv();
    return (
      pick(
        env.ELIZA_AGENT_IMAGE_PLATFORM,
        env.CONTAINERS_DEFAULT_IMAGE_PLATFORM,
        env.AGENT_DOCKER_PLATFORM,
        env.MILADY_DOCKER_PLATFORM,
      ) ?? "linux/amd64"
    );
  },

  /**
   * Seed-only fallback list of nodes used before any node is registered
   * via `POST /api/v1/admin/docker-nodes`.
   * Format: `nodeId:hostname:capacity,nodeId2:hostname2:capacity2`.
   */
  seedNodes(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_DOCKER_NODES, env.AGENT_DOCKER_NODES);
  },

  /** Application port baked into the canonical Eliza agent image. */
  agentPort(): string {
    const env = getCloudAwareEnv();
    return pick(env.ELIZA_AGENT_PORT, env.AGENT_AGENT_PORT, env.MILADY_AGENT_PORT) ?? "3000";
  },

  /** Bridge port the agent listens on inside the container (for agent-server bridge). */
  agentBridgePort(): string {
    const env = getCloudAwareEnv();
    return (
      pick(env.ELIZA_AGENT_BRIDGE_PORT, env.AGENT_BRIDGE_INTERNAL_PORT, env.MILADY_BRIDGE_INTERNAL_PORT) ??
      "31337"
    );
  },

  /** Legacy "ELIZA_PORT" — kept as a transitional env var for the agent image. */
  legacyContainerPort(): string {
    const env = getCloudAwareEnv();
    return pick(env.AGENT_CONTAINER_PORT) ?? "2138";
  },

  /** Hetzner Cloud API token for elastic node provisioning. Optional. */
  hetznerCloudToken(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.HCLOUD_TOKEN, env.HETZNER_CLOUD_TOKEN, env.HETZNER_CLOUD_API_KEY);
  },

  /**
   * Base domain for per-container public hostnames (e.g.
   * `containers.elizacloud.ai`). When set, every new container gets
   * `<short-id>.<base-domain>` written to `public_hostname` and is
   * surfaced in the ingress map. Operators run a reverse proxy that
   * resolves these to the corresponding node:port upstream.
   */
  publicBaseDomain(): string | undefined {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_PUBLIC_BASE_DOMAIN, env.ELIZA_CLOUD_AGENT_BASE_DOMAIN);
  },

  /**
   * Default Hetzner Cloud location for provisioning nodes and volumes
   * (e.g. "ash", "hil", "fsn1"). Hetzner volumes are location-bound, so
   * the volume and the server it attaches to must share a location.
   * Defaults to "ash" (Ashburn, Virginia, US).
   */
  defaultHcloudLocation(): string {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_HCLOUD_LOCATION, env.HCLOUD_LOCATION) ?? "ash";
  },

  /**
   * Default Hetzner Cloud server type for elastic Docker nodes. Keep this on
   * x86 because the managed agent image defaults to linux/amd64.
   */
  defaultHcloudServerType(): string {
    const env = getCloudAwareEnv();
    return pick(env.CONTAINERS_HCLOUD_SERVER_TYPE, env.HCLOUD_SERVER_TYPE) ?? "cpx32";
  },

  // ── Warm pool ───────────────────────────────────────────────────────────

  /**
   * Whether the agent warm pool is enabled. When false, claim flow always
   * falls through to the cold-start async path; replenish/drain crons no-op.
   * Default: false (opt-in).
   */
  warmPoolEnabled(): boolean {
    const env = getCloudAwareEnv();
    const raw = pick(env.WARM_POOL_ENABLED);
    return raw === "true" || raw === "1";
  },

  /**
   * Maximum number of pool containers ever provisioned. The forecast may
   * recommend more, but this is the hard ceiling on cost.
   * Default: 10.
   */
  warmPoolMaxSize(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.WARM_POOL_MAX_SIZE);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 1 ? Math.min(50, Math.floor(parsed)) : 10;
  },

  /**
   * Floor: the pool replenisher will keep at least this many containers
   * ready when the pool is enabled. Default: 1.
   */
  warmPoolMinSize(): number {
    const env = getCloudAwareEnv();
    const raw = pick(env.WARM_POOL_MIN_SIZE);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
  },
};
