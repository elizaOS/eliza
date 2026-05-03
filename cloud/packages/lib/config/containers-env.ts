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

function pick(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate && candidate.length > 0) return candidate;
  }
  return undefined;
}

export const containersEnv = {
  /** Base64-encoded SSH private key for connecting to Docker nodes. */
  sshKey(): string | undefined {
    return pick(process.env.CONTAINERS_SSH_KEY, process.env.AGENT_SSH_KEY);
  },

  /** Filesystem path to the SSH private key (used when sshKey() is unset). */
  sshKeyPath(): string | undefined {
    return pick(process.env.CONTAINERS_SSH_KEY_PATH, process.env.AGENT_SSH_KEY_PATH);
  },

  /** SSH user for connecting to Docker nodes. Defaults to "root". */
  sshUser(): string {
    return pick(process.env.CONTAINERS_SSH_USER, process.env.AGENT_SSH_USER) ?? "root";
  },

  /** Docker network name created on every node. Containers attach to this. */
  dockerNetwork(): string {
    return (
      pick(process.env.CONTAINERS_DOCKER_NETWORK, process.env.AGENT_DOCKER_NETWORK) ??
      "containers-isolated"
    );
  },

  /**
   * Default agent image when a caller asks for the canonical Eliza agent
   * flavor without specifying a tag. Operators can pin a specific tag here
   * without code changes.
   */
  defaultAgentImage(): string {
    return (
      pick(
        process.env.ELIZA_AGENT_IMAGE,
        process.env.CONTAINERS_DEFAULT_IMAGE,
        process.env.AGENT_DOCKER_IMAGE,
      ) ?? "ghcr.io/elizaos/eliza:latest"
    );
  },

  /**
   * Seed-only fallback list of nodes used before any node is registered
   * via `POST /api/v1/admin/docker-nodes`.
   * Format: `nodeId:hostname:capacity,nodeId2:hostname2:capacity2`.
   */
  seedNodes(): string | undefined {
    return pick(process.env.CONTAINERS_DOCKER_NODES, process.env.AGENT_DOCKER_NODES);
  },

  /** Application port baked into the canonical Eliza agent image. */
  agentPort(): string {
    return pick(process.env.ELIZA_AGENT_PORT, process.env.AGENT_AGENT_PORT) ?? "2139";
  },

  /** Bridge port the agent listens on inside the container (for agent-server bridge). */
  agentBridgePort(): string {
    return (
      pick(process.env.ELIZA_AGENT_BRIDGE_PORT, process.env.AGENT_BRIDGE_INTERNAL_PORT) ?? "31337"
    );
  },

  /** Legacy "ELIZA_PORT" — kept as a transitional env var for the agent image. */
  legacyContainerPort(): string {
    return pick(process.env.AGENT_CONTAINER_PORT) ?? "2138";
  },

  /** Hetzner Cloud API token for elastic node provisioning. Optional. */
  hetznerCloudToken(): string | undefined {
    return pick(process.env.HCLOUD_TOKEN, process.env.HETZNER_CLOUD_TOKEN);
  },

  /**
   * Base domain for per-container public hostnames (e.g.
   * `containers.elizacloud.ai`). When set, every new container gets
   * `<short-id>.<base-domain>` written to `public_hostname` and is
   * surfaced in the ingress map. Operators run a reverse proxy that
   * resolves these to the corresponding node:port upstream.
   */
  publicBaseDomain(): string | undefined {
    return pick(
      process.env.CONTAINERS_PUBLIC_BASE_DOMAIN,
      process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
    );
  },

  /**
   * Default Hetzner Cloud location for provisioning nodes and volumes
   * (e.g. "fsn1", "nbg1", "hel1"). Hetzner Cloud volumes are
   * location-bound — the volume and the server it attaches to must be in
   * the same location. Defaults to "fsn1" (Falkenstein, Germany).
   */
  defaultHcloudLocation(): string {
    return pick(process.env.CONTAINERS_HCLOUD_LOCATION, process.env.HCLOUD_LOCATION) ?? "fsn1";
  },
};
