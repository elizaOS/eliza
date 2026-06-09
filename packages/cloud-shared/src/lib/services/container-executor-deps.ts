/**
 * Container-executor deps composition (Apps / Product 2) — builds the
 * `{ provider, store }` backend that `setContainerExecutorDeps` injects, so the
 * daemon's `getContainerExecutorDeps()` resolves a REAL provider (SSH -> docker
 * on a worker node) + the REAL container store (over `containers`).
 *
 * Kept in cloud-shared (not the daemon file) so the daemon edit stays a one-line
 * `setContainerExecutorDeps(buildContainerExecutorDeps)` and the composition is
 * unit-testable / reusable. NODE-ONLY: it uses `DockerSSHClient` (ssh2) and is
 * wired only into the node daemon — never the Worker.
 *
 * FEATURE GATE: returns deps that throw a clear error if the apps-container
 * backend isn't configured (no docker nodes / no SSH key), so wiring it in is
 * safe even before infra env is present — provision only runs when a
 * CONTAINER_* job is claimed AND the env is set. Set `APPS_CONTAINERS_ENABLED=1`
 * (or rely on `CONTAINERS_DOCKER_NODES` being present) to arm it.
 */

import { Buffer } from "node:buffer";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import {
  AppContainerProvider,
  type AppContainerProviderDeps,
  type AppContainerSsh,
  type ProvisionAppContainerParams,
  type ProvisionedAppContainer,
} from "./app-container-provider";
import { appContainerStore } from "./app-container-store";
import { addAppRoute, removeAppRoute } from "./apps-ingress-provisioner";
import type { ContainerExecutorDeps } from "./container-job-executors";
import { allocateAppContainerHostPort } from "./docker-port-allocation";
import { dockerNodeManager } from "./docker-node-manager";
import { DockerSSHClient } from "./docker-ssh";
import { listVerifiedAppOrigins } from "./managed-domains";

export interface ParsedSeedDockerNode {
  nodeId: string;
  hostname: string;
}

/** True when the apps-container provision backend has enough env to run. */
export function appsContainersEnabled(): boolean {
  if (process.env.APPS_CONTAINERS_ENABLED === "0") return false;
  const hasSeed = Boolean(containersEnv.seedNodes());
  const hasKey = Boolean(containersEnv.sshKey() || containersEnv.sshKeyPath());
  return hasSeed && hasKey;
}

/** Parse `nodeId:hostname:capacity` from the CONTAINERS_DOCKER_NODES seed list. */
export function parseSeedDockerNodeEntry(entry: string): ParsedSeedDockerNode | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length >= 2) {
    const nodeId = parts[0]?.trim();
    const hostname = parts[1]?.trim();
    if (nodeId && hostname) return { nodeId, hostname };
  }
  const host = parts[0]?.trim();
  if (host) return { nodeId: host, hostname: host };
  return null;
}

export function parseFirstSeedNodeOrNull(): ParsedSeedDockerNode | null {
  const seed = containersEnv.seedNodes();
  if (!seed) return null;
  const first = seed.split(",")[0]?.trim();
  if (!first) return null;
  return parseSeedDockerNodeEntry(first);
}

/** Prefer the registered docker_nodes pool; fall back to the seed list. */
export async function resolveAppContainerNode(): Promise<ParsedSeedDockerNode> {
  const managed = await dockerNodeManager.getAvailableNode();
  if (managed) {
    return { nodeId: managed.node_id, hostname: managed.hostname };
  }
  const seeded = parseFirstSeedNodeOrNull();
  if (seeded) return seeded;
  throw new Error(
    "No docker node capacity available — register nodes or set CONTAINERS_DOCKER_NODES",
  );
}

async function resolveNodePlacement(
  nodeId?: string | null,
): Promise<ParsedSeedDockerNode> {
  if (nodeId) {
    const configured = await dockerNodeManager.getNodeConfig(nodeId);
    if (configured) {
      return { nodeId: configured.node_id, hostname: configured.hostname };
    }
    const seeded = parseFirstSeedNodeOrNull();
    if (seeded?.nodeId === nodeId) return seeded;
    throw new Error(`Docker node ${nodeId} is not registered`);
  }
  return resolveAppContainerNode();
}

function buildProviderForNode(
  node: ParsedSeedDockerNode,
  shared: Omit<AppContainerProviderDeps, "ssh" | "allocateHostPort">,
): AppContainerProvider {
  return new AppContainerProvider({
    ...shared,
    ssh: makeNodeSsh(node.hostname),
    allocateHostPort: () => allocateAppContainerHostPort(node.nodeId),
  });
}

function makeNodeSsh(hostname: string): AppContainerSsh {
  const keyB64 = containersEnv.sshKey();
  const privateKey = keyB64 ? Buffer.from(keyB64, "base64") : undefined;
  const client = privateKey
    ? new DockerSSHClient({ hostname, username: containersEnv.sshUser(), privateKey })
    : new DockerSSHClient({
        hostname,
        username: containersEnv.sshUser(),
        privateKeyPath: containersEnv.sshKeyPath(),
      });
  return { exec: (command, timeoutMs) => client.exec(command, timeoutMs) };
}

/**
 * Provider that picks the least-loaded docker node per provision, allocates a
 * collision-safe host port on that node, and records `nodeId` for ingress/LB.
 */
export class NodeSelectingAppContainerProvider {
  private readonly shared: Omit<AppContainerProviderDeps, "ssh" | "allocateHostPort">;

  constructor(shared: Omit<AppContainerProviderDeps, "ssh" | "allocateHostPort">) {
    this.shared = shared;
  }

  async provision(params: ProvisionAppContainerParams): Promise<ProvisionedAppContainer> {
    const node = await resolveAppContainerNode();
    await dockerNodesRepository.incrementAllocated(node.nodeId);
    try {
      const result = await buildProviderForNode(node, this.shared).provision(params);
      return { ...result, nodeId: node.nodeId, nodeHost: node.hostname };
    } catch (error) {
      try {
        await dockerNodesRepository.decrementAllocated(node.nodeId);
      } catch (rollbackError) {
        logger.warn("[container-executor-deps] Failed to rollback node allocation", {
          nodeId: node.nodeId,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    }
  }

  async delete(containerName: string, nodeId?: string | null): Promise<void> {
    const node = await resolveNodePlacement(nodeId);
    await buildProviderForNode(node, this.shared).delete(containerName);
    if (nodeId) {
      try {
        await dockerNodesRepository.decrementAllocated(node.nodeId);
      } catch (error) {
        logger.warn("[container-executor-deps] Failed to decrement node allocation on delete", {
          nodeId: node.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async restart(containerName: string, nodeId?: string | null): Promise<void> {
    const node = await resolveNodePlacement(nodeId);
    await buildProviderForNode(node, this.shared).restart(containerName);
  }

  async logs(containerName: string, tail = 200, nodeId?: string | null): Promise<string> {
    const node = await resolveNodePlacement(nodeId);
    return buildProviderForNode(node, this.shared).logs(containerName, tail);
  }
}

/**
 * Build the executor backend. Pass to `setContainerExecutorDeps(() => ...)`.
 * Throws (lazily, when a job actually runs) if the backend isn't configured —
 * so wiring it is always safe; nothing connects until a CONTAINER_* job lands.
 */
export function buildContainerExecutorDeps(): ContainerExecutorDeps {
  if (!appsContainersEnabled()) {
    throw new Error(
      "Apps container backend not configured (need CONTAINERS_DOCKER_NODES + CONTAINERS_SSH_KEY/_PATH). " +
        "A CONTAINER_* job was claimed but cannot be provisioned.",
    );
  }
  const egressProxyUrl = process.env.CONTAINERS_EGRESS_PROXY_URL || undefined;
  const dbEgressNetwork = process.env.APPS_DB_EGRESS_NETWORK || undefined;
  const ambassadorImage = process.env.APPS_DB_AMBASSADOR_IMAGE || undefined;
  const provider = new NodeSelectingAppContainerProvider({
    egressProxyUrl,
    dbEgressNetwork,
    ambassadorImage,
  });

  // Ingress route hooks — wired only when a Caddy admin URL is configured.
  // Otherwise routes are no-ops (the deploy still succeeds; the app just has no
  // public URL until ingress is set up).
  const caddyAdminUrl = containersEnv.caddyAdminUrl();
  const ingress: Pick<ContainerExecutorDeps, "onRouteAdded" | "onRouteRemoved"> = caddyAdminUrl
    ? {
        onRouteAdded: (route) => addAppRoute({ ...route, adminBase: caddyAdminUrl }),
        onRouteRemoved: (route) => removeAppRoute({ ...route, adminBase: caddyAdminUrl }),
      }
    : {};

  logger.info("[container-executor-deps] built apps container backend", {
    seedNode: parseFirstSeedNodeOrNull()?.nodeId ?? "docker_nodes_pool",
    egressProxy: Boolean(egressProxyUrl),
    dbEgressNetwork: dbEgressNetwork ?? "bridge",
    ingress: Boolean(caddyAdminUrl),
  });
  return {
    provider,
    store: appContainerStore,
    // Verified custom domains for the app -> bare hostnames, folded into the
    // ingress route's host-match. Reuses the existing CORS verified-origin query
    // (status='active' AND verified=true); only invoked when ingress is wired.
    listVerifiedAppHostnames: (appId) =>
      listVerifiedAppOrigins(appId).then((origins) =>
        origins.map((origin) => origin.replace(/^https?:\/\//, "").replace(/\/+$/, "")),
      ),
    ...ingress,
  };
}
