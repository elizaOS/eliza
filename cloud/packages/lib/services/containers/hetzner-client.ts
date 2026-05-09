/**
 * Hetzner Containers Client
 *
 * Typed adapter that the `/api/v1/containers/*` routes use to drive the
 * underlying Hetzner-Docker control plane. Wraps the existing
 * `DockerSSHClient` + `dockerNodesRepository` so the route layer stays free
 * of SSH, port allocation, and node-selection details.
 *
 * This is intentionally a NARROW interface — the public surface for
 * "user containers" is a small subset of what the Docker sandbox backend
 * supports for agent sandboxes. New methods get added here only when a route
 * needs them.
 *
 * Implementation notes:
 *
 * - `containerId` in this client maps 1:1 to `containers.id` in the DB.
 *   The Docker `containerName` (e.g. `cloud-container-<id>`) is an internal
 *   detail derived from container metadata.
 *
 * - This module imports `ssh2` transitively via `DockerSSHClient` and is
 *   therefore Node-only. Cloudflare Workers cannot host the routes that use
 *   it; they run on the Node sidecar (see INFRA.md "Container backend").
 *
 * - All errors are normalized to `HetznerClientError` so the route layer
 *   has a single error type to map to HTTP status codes.
 */

import { and, eq, sql } from "drizzle-orm";
import * as fs from "fs";
import { dbRead, dbWrite } from "@/db/client";
import {
  type Container,
  containersRepository,
  type NewContainer,
} from "@/db/repositories/containers";
import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import { containers as containersTable } from "@/db/schemas/containers";
import type { DockerNode } from "@/db/schemas/docker-nodes";
import { dockerNodes as dockerNodesTable } from "@/db/schemas/docker-nodes";
import { containersEnv } from "@/lib/config/containers-env";
import {
  getHetznerVolumeService,
  isHetznerVolumesAvailable,
} from "@/lib/services/containers/hetzner-volumes";
import { dockerNodeManager } from "@/lib/services/docker-node-manager";
import { getUsedDockerHostPorts } from "@/lib/services/docker-port-allocation";
import {
  allocatePort,
  shellQuote,
  WEBUI_PORT_MAX,
  WEBUI_PORT_MIN,
} from "@/lib/services/docker-sandbox-utils";
import { DockerSSHClient } from "@/lib/services/docker-ssh";
import { logger } from "@/lib/utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reasons a Hetzner client call can fail in a way the route layer cares about. */
export type HetznerClientErrorCode =
  | "container_not_found"
  | "no_capacity"
  | "image_pull_failed"
  | "container_create_failed"
  | "container_stop_failed"
  | "ssh_unreachable"
  | "invalid_input";

export class HetznerClientError extends Error {
  constructor(
    public readonly code: HetznerClientErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HetznerClientError";
  }
}

/** Inputs accepted by `createContainer`. Mirrors the public POST schema. */
export interface CreateContainerInput {
  name: string;
  projectName: string;
  description?: string;
  organizationId: string;
  userId: string;
  apiKeyId?: string | null;

  /** Full image reference (e.g. `ghcr.io/owner/repo:tag`). The control plane runs `docker pull` on the target node. */
  image: string;

  /** Application port the container listens on. */
  port: number;

  /** Number of replicas. Currently must be 1 — multi-replica containers are not supported on the shared Docker pool. */
  desiredCount: number;

  /** CPU units (kept for API compat / billing; not enforced by Docker scheduler). */
  cpu: number;

  /** Memory MB (passed to `docker run --memory`). */
  memoryMb: number;

  /** Optional health-check path (probed by the cron monitor). */
  healthCheckPath?: string;

  /** Environment variables injected into the container. */
  environmentVars?: Record<string, string>;

  /**
   * Mount a project-scoped persistent volume on the host at
   * `/data/projects/<organization_id>/<project_name>` and bind it to
   * `/data` inside the container.
   *
   * The volume is keyed by `(organization_id, project_name)` so a
   * redeploy of the same project reuses the same data. Pinned to the
   * node where the volume lives — re-deploys of a project schedule to
   * that node as long as it has capacity.
   *
   * Defaults to false; stateless workloads do not need a volume.
   */
  persistVolume?: boolean;

  /**
   * Back the project volume with a Hetzner Cloud network-attached block
   * device instead of a local host directory. When true:
   *
   *   - A Hetzner Cloud volume is created (or found) for the project and
   *     attached to the target node before the container starts.
   *   - The volume can be migrated to any other Cloud node in the same
   *     location by detaching and reattaching — the agent's data travels
   *     with it regardless of which physical host is running.
   *   - Only valid when `persistVolume` is also true.
   *   - Requires `HCLOUD_TOKEN` to be set. Ignored (falls back to local
   *     host volume) when the Hetzner Cloud API is not configured.
   */
  useHetznerVolume?: boolean;

  /** Informational declared volume size in GiB (enforced when creating a Hetzner Cloud volume). */
  volumeSizeGb?: number;
}

/** Stored per-container metadata that lives in `containers.metadata` jsonb. */
export interface HetznerContainerMetadata {
  /** Identifies the backend used to provision this container. */
  provider: "hetzner-docker";
  /** Docker node the container is allocated to (`docker_nodes.node_id`). */
  nodeId: string;
  /** Hostname / IP of the Docker node (snapshot at create-time). */
  hostname: string;
  /** Docker container name on the host (e.g. `cloud-container-<id>`). */
  containerName: string;
  /** Host port mapped to the application port. */
  hostPort: number;
  /** Image pulled / running on the node. */
  image: string;
  /** Application port inside the container. */
  containerPort: number;
  /** Host filesystem path mounted at `/data` inside the container, if persistent. */
  volumePath?: string;
}

/** Container summary returned to API callers. */
export interface ContainerSummary {
  id: string;
  name: string;
  projectName: string;
  status: Container["status"];
  publicUrl: string | null;
  image: string;
  createdAt: Date;
  updatedAt: Date;
  errorMessage: string | null;
  metadata: HetznerContainerMetadata | null;
}

export interface LogChunk {
  timestamp: Date;
  stream: "stdout" | "stderr";
  message: string;
}

export interface ContainerMetricsSnapshot {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  capturedAt: Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_NODE_NETWORK = containersEnv.dockerNetwork();

/** Generate a Docker-safe container name from the DB id. */
function deriveContainerName(containerId: string): string {
  return `cloud-container-${containerId.replace(/-/g, "")}`;
}

/**
 * Build the public hostname for a container under the configured base
 * domain. Uses a short id slice so the URL is short and shareable while
 * staying collision-resistant. Returns null when no base domain is set.
 */
function derivePublicHostname(containerId: string): string | null {
  const baseDomain = containersEnv.publicBaseDomain();
  if (!baseDomain) return null;
  // 8 hex chars from the (UUID v4) container id is enough for ≪10^9 IDs
  // before a meaningful collision risk; the full id is still the unique
  // key in the DB so a duplicate hostname would simply collide on the
  // index and surface as an error to the operator.
  const shortId = containerId.replace(/-/g, "").slice(0, 8);
  return `${shortId}.${baseDomain}`;
}

/**
 * Host filesystem path for a project's persistent volume.
 *
 * Treats `(organizationId, projectName)` as the durable agent identity:
 * redeploying a container with the same project_name in the same org
 * reuses this path, so the agent's data survives container replacement.
 * The org_id prefix isolates volumes between tenants on shared hosts.
 *
 * Path is sanitized — project names go through a strict slug filter so a
 * user-supplied name cannot escape the volume root via shell or path
 * tricks. The schema already validates project_name length and shape,
 * but this is a belt-and-braces guard.
 */
function deriveVolumePath(organizationId: string, projectName: string): string {
  const safeOrg = organizationId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeProject = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 64);
  if (!safeOrg || !safeProject) {
    throw new HetznerClientError(
      "invalid_input",
      `Cannot derive volume path from organizationId="${organizationId}" projectName="${projectName}"`,
    );
  }
  return `/data/projects/${safeOrg}/${safeProject}`;
}

/** Read the typed metadata blob off a container row, normalizing legacy AWS rows to null. */
function readMetadata(row: Container): HetznerContainerMetadata | null {
  const raw = row.metadata as Record<string, unknown> | null | undefined;
  if (!raw || raw.provider !== "hetzner-docker") return null;
  // Trust the shape because we wrote it. The provider tag is the discriminator.
  return raw as unknown as HetznerContainerMetadata;
}

function rowToSummary(row: Container): ContainerSummary {
  const meta = readMetadata(row);
  return {
    id: row.id,
    name: row.name,
    projectName: row.project_name,
    status: row.status,
    publicUrl: row.load_balancer_url ?? null,
    image:
      meta?.image ?? ((row.metadata as Record<string, unknown>)?.ecr_image_uri as string) ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorMessage: row.error_message ?? null,
    metadata: meta,
  };
}

function validateEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new HetznerClientError(
      "invalid_input",
      `Invalid environment variable name: '${key}'. Must start with letter/underscore and contain only alphanumeric and underscores.`,
    );
  }
}

/**
 * Look up the node that already hosts a persistent volume for this
 * project. Used to pin redeploys to the same node so stateful agents
 * keep their data. Returns null when no prior container in this
 * project has a volume, or when the prior node is offline / disabled /
 * full.
 */
async function findStickyNodeForProject(
  organizationId: string,
  projectName: string,
): Promise<DockerNode | null> {
  const [row] = await dbRead
    .select({ node_id: containersTable.node_id })
    .from(containersTable)
    .where(
      and(
        eq(containersTable.organization_id, organizationId),
        eq(containersTable.project_name, projectName),
        sql`${containersTable.node_id} is not null`,
        sql`${containersTable.volume_path} is not null`,
        sql`${containersTable.status} not in ('failed','deleted')`,
      ),
    )
    .orderBy(sql`${containersTable.created_at} desc`)
    .limit(1);

  if (!row?.node_id) return null;

  const node = await dockerNodesRepository.findByNodeId(row.node_id);
  if (!node || !node.enabled || node.status !== "healthy") return null;
  if (node.allocated_count >= node.capacity) return null;

  return node;
}

/**
 * Find the least-loaded healthy node whose Hetzner Cloud location matches
 * `location`. Only Cloud-provisioned nodes carry `metadata.location`; manually
 * registered auctioned/dedicated nodes will not appear in these results.
 */
async function findNodeInLocation(location: string): Promise<DockerNode | null> {
  const [r] = await dbRead
    .select()
    .from(dockerNodesTable)
    .where(
      and(
        eq(dockerNodesTable.enabled, true),
        eq(dockerNodesTable.status, "healthy"),
        sql`${dockerNodesTable.allocated_count} < ${dockerNodesTable.capacity}`,
        sql`${dockerNodesTable.metadata}->>'location' = ${location}`,
      ),
    )
    .orderBy(sql`(${dockerNodesTable.capacity} - ${dockerNodesTable.allocated_count}) DESC`)
    .limit(1);
  return r ?? null;
}

function getDockerNodeLocation(node: DockerNode): string | null {
  const location = node.metadata.location;
  return typeof location === "string" ? location : null;
}

function getImageRegistryHost(image: string): string | null {
  const firstSegment = image.split("/")[0];
  if (!firstSegment) return null;
  if (firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost") {
    return firstSegment;
  }
  return null;
}

function readRegistryToken(): string | undefined {
  const envToken = containersEnv.registryToken();
  if (envToken) return envToken;

  const tokenFile = containersEnv.registryTokenFile();
  if (!tokenFile) return undefined;

  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    return token || undefined;
  } catch (error) {
    throw new HetznerClientError(
      "invalid_input",
      `Failed to read Docker registry token file '${tokenFile.split("/").pop() ?? "unknown"}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loginToImageRegistry(ssh: DockerSSHClient, image: string): Promise<void> {
  const registryHost = getImageRegistryHost(image);
  const username = containersEnv.registryUsername();
  const token = readRegistryToken();
  if (!registryHost && !username && !token) return;
  if (!registryHost) return;
  if (!username || !token) {
    throw new HetznerClientError(
      "invalid_input",
      `Docker registry credentials are required to pull from ${registryHost}`,
    );
  }

  await ssh.exec(
    `printf %s ${shellQuote(token)} | docker login ${shellQuote(registryHost)} -u ${shellQuote(username)} --password-stdin >/dev/null`,
    60_000,
  );
}

// ---------------------------------------------------------------------------
// HetznerContainersClient
// ---------------------------------------------------------------------------

export class HetznerContainersClient {
  // ----------------------------------------------------------------------
  // CRUD
  // ----------------------------------------------------------------------

  /**
   * Create a new container row, allocate a Docker node, pull the image,
   * and start the container. Returns the persisted summary as soon as the
   * container is in `deploying` state — the cron monitor flips to
   * `running` once the Docker health check reports healthy.
   *
   * This method is intentionally synchronous through `docker run`. The
   * SSH+pull+create+start sequence typically takes 20–60s, well below
   * any sane HTTP timeout. Long-haul image pulls (~5min) still complete
   * inside the SSH command timeout (`PULL_TIMEOUT_MS`).
   */
  async createContainer(input: CreateContainerInput): Promise<ContainerSummary> {
    if (input.desiredCount !== 1) {
      throw new HetznerClientError(
        "invalid_input",
        `desiredCount must be 1; multi-replica containers are not supported on the Hetzner-Docker pool.`,
      );
    }
    if (input.environmentVars) {
      for (const key of Object.keys(input.environmentVars)) validateEnvKey(key);
    }

    // 1. Pre-create the DB row in `pending` so the rest of the flow has an id.
    const newRow: NewContainer = {
      name: input.name,
      project_name: input.projectName,
      description: input.description ?? null,
      organization_id: input.organizationId,
      user_id: input.userId,
      api_key_id: input.apiKeyId ?? null,
      image_tag: input.image,
      port: input.port,
      desired_count: 1,
      cpu: input.cpu,
      memory: input.memoryMb,
      environment_vars: input.environmentVars ?? {},
      health_check_path: input.healthCheckPath ?? "/health",
      status: "pending",
      metadata: { provider: "hetzner-docker", image: input.image },
    };

    const row = await containersRepository.createWithQuotaCheck(newRow);

    // 2. Hetzner Cloud volume pre-flight. Create or find the volume before
    // node selection so scheduling can respect the volume's location.
    const requestedHcloudVolume = input.persistVolume && input.useHetznerVolume;
    const hcloudVolumesAvailable = isHetznerVolumesAvailable();
    if (requestedHcloudVolume && !hcloudVolumesAvailable) {
      logger.warn(
        "[hetzner-client] useHetznerVolume requested without HCLOUD_TOKEN; using local host volume",
        {
          organizationId: input.organizationId,
          projectName: input.projectName,
        },
      );
    }
    const wantHcloudVolume = requestedHcloudVolume && hcloudVolumesAvailable;

    let hcloudVolumeId: number | undefined;
    let hcloudVolumeLocation: string | undefined;

    if (wantHcloudVolume) {
      const volService = getHetznerVolumeService();
      const defaultLocation = containersEnv.defaultHcloudLocation();
      const volume = await volService.getOrCreateProjectVolume(
        { organizationId: input.organizationId, projectName: input.projectName },
        { sizeGb: input.volumeSizeGb ?? 10, location: defaultLocation },
      );
      hcloudVolumeId = volume.id;
      hcloudVolumeLocation = volume.location.name;
    }

    // 3. Node selection.
    //
    // Stateful workloads need to land on the same node as the existing
    // volume. For Hetzner Cloud volumes, the node MUST be in the same
    // Hetzner location as the volume (location-bound block storage).
    //
    // Priority:
    //   a) Sticky node from a prior container in this project (if healthy,
    //      has capacity, and for hcloud volumes is in the right location)
    //   b) Least-loaded node in the volume's location (hcloud volumes only)
    //   c) Global least-loaded node (stateless or local-volume workloads)
    let node: DockerNode | null = null;

    if (input.persistVolume) {
      const sticky = await findStickyNodeForProject(input.organizationId, input.projectName);
      if (sticky) {
        if (hcloudVolumeLocation) {
          if (getDockerNodeLocation(sticky) === hcloudVolumeLocation) {
            node = (await dockerNodeManager.ensureNodeReady(sticky)) ? sticky : null;
          }
        } else {
          node = (await dockerNodeManager.ensureNodeReady(sticky)) ? sticky : null;
        }
      }
    }

    if (!node && hcloudVolumeLocation) {
      const located = await findNodeInLocation(hcloudVolumeLocation);
      node = located && (await dockerNodeManager.ensureNodeReady(located)) ? located : null;
    }

    if (!node && !hcloudVolumeLocation) {
      node = await dockerNodeManager.getAvailableNode();
    }

    if (!node) {
      await containersRepository.updateStatus(
        row.id,
        "failed",
        "No Hetzner-Docker capacity available — register more nodes or wait for existing containers to drain.",
      );
      throw new HetznerClientError("no_capacity", "No Hetzner-Docker capacity available");
    }

    // 4. SSH into the node, pull the image, create + start the container.
    const ssh = DockerSSHClient.getClient(
      node.hostname,
      node.ssh_port ?? 22,
      node.host_key_fingerprint ?? undefined,
      node.ssh_user ?? "root",
    );

    const containerName = deriveContainerName(row.id);
    const usedPorts = await getUsedDockerHostPorts(node.node_id);

    // Local volume path - used for non-hcloud persistent volumes. For hcloud
    // volumes this is set after the attach step below.
    let volumePath: string | undefined =
      input.persistVolume && !wantHcloudVolume
        ? deriveVolumePath(input.organizationId, input.projectName)
        : undefined;

    try {
      await containersRepository.update(row.id, input.organizationId, {
        status: "building",
        deployment_log: `Pulling image ${input.image} on ${node.node_id}...`,
      });
      await loginToImageRegistry(ssh, input.image);
      await ssh.exec(`docker pull ${shellQuote(input.image)}`, 5 * 60 * 1000);

      // 5. Hetzner Cloud volume attachment. The volume service handles:
      //    - waiting for the block device to appear after attach
      //    - mkfs.ext4 on first use (idempotent: skipped if already formatted)
      //    - mkdir -p + mount at the canonical project path
      if (wantHcloudVolume && hcloudVolumeId !== undefined) {
        const volService = getHetznerVolumeService();
        const attached = await volService.attachToNode(hcloudVolumeId, node, {
          organizationId: input.organizationId,
          projectName: input.projectName,
        });
        volumePath = attached.mountPath;
        // Confirm location matches what we stored from the volume record.
        hcloudVolumeLocation = attached.location;
      } else if (volumePath) {
        // Local host volume: pre-create the directory so the bind-mount
        // works even on a freshly-provisioned node.
        await ssh.exec(`mkdir -p ${shellQuote(volumePath)}`, 30_000);
      }

      const envFlags = Object.entries(input.environmentVars ?? {})
        .map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`)
        .join(" ");

      let hostPort: number | undefined;
      const maxPortAttempts = 5;
      for (let attempt = 1; attempt <= maxPortAttempts; attempt++) {
        hostPort = allocatePort(WEBUI_PORT_MIN, WEBUI_PORT_MAX, usedPorts);
        const dockerCreateCmd = [
          "docker create",
          `--name ${shellQuote(containerName)}`,
          "--restart unless-stopped",
          `--network ${shellQuote(DEFAULT_NODE_NETWORK)}`,
          `--memory ${input.memoryMb}m`,
          ...(volumePath ? [`-v ${shellQuote(volumePath)}:/data`] : []),
          `-p ${hostPort}:${input.port}`,
          envFlags,
          shellQuote(input.image),
        ]
          .filter((part) => part.length > 0)
          .join(" ");

        try {
          await ssh.exec(dockerCreateCmd, 60_000);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isPortCollision =
            message.includes("already in use") ||
            message.includes("port is already allocated") ||
            message.includes("Bind for 0.0.0.0");
          if (!isPortCollision || attempt === maxPortAttempts) {
            throw error;
          }
          usedPorts.add(hostPort);
          logger.warn("[hetzner-client] host port collision, retrying container create", {
            containerId: row.id,
            nodeId: node.node_id,
            hostPort,
            attempt,
          });
        }
      }
      if (hostPort === undefined) {
        throw new HetznerClientError("container_create_failed", "Failed to allocate host port");
      }
      await ssh.exec(`docker start ${shellQuote(containerName)}`, 60_000);
      await dockerNodesRepository.incrementAllocated(node.node_id);

      const meta: HetznerContainerMetadata = {
        provider: "hetzner-docker",
        nodeId: node.node_id,
        hostname: node.hostname,
        containerName,
        hostPort,
        image: input.image,
        containerPort: input.port,
        ...(volumePath ? { volumePath } : {}),
      };

      const publicHostname = derivePublicHostname(row.id);
      // When a public base domain is configured, the user-facing URL is
      // the stable HTTPS hostname served by the operator's ingress (e.g.
      // Caddy / Cloudflare Tunnel). The raw `node:port` upstream is kept
      // in `metadata.hostname` for the ingress map endpoint to consume.
      const publicUrl = publicHostname
        ? `https://${publicHostname}`
        : `http://${node.hostname}:${hostPort}`;

      const metadata: Record<string, unknown> = { ...meta };
      const updated = await containersRepository.update(row.id, input.organizationId, {
        status: "deploying",
        deployment_log: `Container started on ${node.node_id}; waiting for health check...`,
        load_balancer_url: publicUrl,
        public_hostname: publicHostname,
        node_id: node.node_id,
        volume_path: volumePath ?? null,
        volume_size_gb: input.volumeSizeGb ?? null,
        hcloud_volume_id: hcloudVolumeId ?? null,
        volume_location: hcloudVolumeLocation ?? null,
        metadata,
      });

      return rowToSummary(updated ?? { ...row, metadata });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[hetzner-client] container create failed", {
        containerId: row.id,
        nodeId: node.node_id,
        error: message,
      });
      // Best-effort cleanup of the half-created Docker container. Leave the
      // Hetzner Cloud volume intact; it may contain data if this is a
      // redeploy and the container start failed after attach. Operators can
      // retry because the volume is found by label on the next attempt.
      await ssh.exec(`docker rm -f ${shellQuote(containerName)}`, 30_000).catch(() => {});
      await containersRepository.updateStatus(row.id, "failed", message);
      throw new HetznerClientError("container_create_failed", message, err);
    }
  }

  /** Look up a single container by id, scoped to its organization. */
  async getContainer(
    containerId: string,
    organizationId: string,
  ): Promise<ContainerSummary | null> {
    const row = await containersRepository.findById(containerId, organizationId);
    return row ? rowToSummary(row) : null;
  }

  /** List all containers for an organization. */
  async listContainers(organizationId: string): Promise<ContainerSummary[]> {
    const rows = await containersRepository.listByOrganization(organizationId);
    return rows.map(rowToSummary);
  }

  /**
   * Stop and remove the live Docker container while preserving the control-plane
   * row. This is the lifecycle primitive billing cancellation needs: future
   * billing can stop immediately while the account still has an auditable
   * resource record and, by default, preserved stateful storage.
   */
  async stopContainer(
    containerId: string,
    organizationId: string,
    options: { purgeVolume?: boolean } = {},
  ): Promise<ContainerSummary> {
    const row = await containersRepository.findById(containerId, organizationId);
    if (!row) {
      throw new HetznerClientError("container_not_found", `container ${containerId} not found`);
    }

    const meta = readMetadata(row);
    if (meta) {
      await this.execOnNode(meta, async (ssh) => {
        await ssh
          .exec(`docker stop -t 10 ${shellQuote(meta.containerName)}`, 30_000)
          .catch((err) => {
            logger.warn(`[hetzner-client] docker stop failed for ${meta.containerName}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        await ssh.exec(`docker rm -f ${shellQuote(meta.containerName)}`, 30_000);

        if (!row.hcloud_volume_id && options.purgeVolume && meta.volumePath) {
          if (
            !meta.volumePath.startsWith("/data/projects/") &&
            !meta.volumePath.startsWith("/data/containers/")
          ) {
            logger.error(
              `[hetzner-client] refusing to purge unexpected volume path ${meta.volumePath}`,
            );
          } else {
            await ssh.exec(`rm -rf ${shellQuote(meta.volumePath)}`, 60_000).catch((err) =>
              logger.warn(`[hetzner-client] volume purge failed for ${meta.volumePath}`, {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
      });

      await dockerNodesRepository.decrementAllocated(meta.nodeId).catch((err) => {
        logger.warn(`[hetzner-client] decrementAllocated failed for ${meta.nodeId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    if (row.hcloud_volume_id !== null && isHetznerVolumesAvailable()) {
      const volService = getHetznerVolumeService();
      if (options.purgeVolume) {
        await volService.deleteProjectVolume(row.hcloud_volume_id).catch((err) => {
          logger.error(
            `[hetzner-client] hcloud volume delete failed for volume ${row.hcloud_volume_id}`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        });
      } else if (meta?.volumePath) {
        const node = await dockerNodesRepository.findByNodeId(meta.nodeId);
        if (node) {
          await volService
            .detachFromNode(row.hcloud_volume_id, node, meta.volumePath)
            .catch((err) => {
              logger.warn(
                `[hetzner-client] hcloud volume detach failed for volume ${row.hcloud_volume_id}`,
                { error: err instanceof Error ? err.message : String(err) },
              );
            });
        }
      }
    }

    const updated = await containersRepository.update(containerId, organizationId, {
      status: "stopped",
      next_billing_at: null,
      scheduled_shutdown_at: null,
      shutdown_warning_sent_at: null,
      deployment_log: "Container stopped by billing cancellation.",
    });
    return rowToSummary(updated ?? row);
  }

  /**
   * Tear down a container: stop + remove on the host, decrement the
   * node's allocated count, then delete the DB row. Errors during the
   * SSH stage are surfaced — we do NOT silently delete the row if the
   * host cleanup fails, because that would leak a Docker container.
   *
   * Persistent volumes are PRESERVED on the host by default. Pass
   * `{ purgeVolume: true }` to also `rm -rf` the host volume directory.
   * This separation lets users delete + redeploy a stateful container
   * (e.g. swap the image) without losing the agent's state.
   */
  async deleteContainer(
    containerId: string,
    organizationId: string,
    options: { purgeVolume?: boolean } = {},
  ): Promise<void> {
    const row = await containersRepository.findById(containerId, organizationId);
    if (!row) {
      throw new HetznerClientError("container_not_found", `container ${containerId} not found`);
    }

    const meta = readMetadata(row);
    if (meta) {
      await this.execOnNode(meta, async (ssh) => {
        await ssh
          .exec(`docker stop -t 10 ${shellQuote(meta.containerName)}`, 30_000)
          .catch((err) => {
            logger.warn(`[hetzner-client] docker stop failed for ${meta.containerName}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        await ssh.exec(`docker rm -f ${shellQuote(meta.containerName)}`, 30_000);

        // Local host volume cleanup - only when there is no Hetzner Cloud
        // volume backing this path (hcloud volumes are managed separately below).
        if (!row.hcloud_volume_id && options.purgeVolume && meta.volumePath) {
          // Defense in depth: only purge paths under /data/projects/ (or
          // the legacy /data/containers/ prefix). The schema is the only
          // writer of these paths, so this is a belt-and-braces guard
          // against malformed metadata reaching `rm -rf`.
          if (
            !meta.volumePath.startsWith("/data/projects/") &&
            !meta.volumePath.startsWith("/data/containers/")
          ) {
            logger.error(
              `[hetzner-client] refusing to purge unexpected volume path ${meta.volumePath}`,
            );
          } else {
            await ssh.exec(`rm -rf ${shellQuote(meta.volumePath)}`, 60_000).catch((err) =>
              logger.warn(`[hetzner-client] volume purge failed for ${meta.volumePath}`, {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
      });

      await dockerNodesRepository.decrementAllocated(meta.nodeId).catch((err) => {
        logger.warn(`[hetzner-client] decrementAllocated failed for ${meta.nodeId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Hetzner Cloud volume lifecycle - handled after Docker cleanup so the
    // container is no longer running when we unmount/detach.
    if (row.hcloud_volume_id !== null && isHetznerVolumesAvailable()) {
      const volService = getHetznerVolumeService();
      if (options.purgeVolume) {
        // Hard-delete: detach + delete the block device. All data is lost.
        await volService.deleteProjectVolume(row.hcloud_volume_id).catch((err) => {
          logger.error(
            `[hetzner-client] hcloud volume delete failed for volume ${row.hcloud_volume_id}`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        });
      } else if (meta?.volumePath) {
        // Soft-delete: unmount on the node + detach from the Hetzner Cloud
        // server. The volume stays in the project's account and can be
        // reattached on the next deploy.
        //
        // TypeScript narrows `meta` to non-null here (optional-chain
        // truthiness check), and `mountPath` to `string` (from `string |
        // undefined`), so both can be passed to `detachFromNode` safely.
        const mountPath = meta.volumePath as string;
        const node = await dockerNodesRepository.findByNodeId(meta.nodeId);
        if (node) {
          await volService.detachFromNode(row.hcloud_volume_id, node, mountPath).catch((err) => {
            logger.warn(
              `[hetzner-client] hcloud volume detach failed for volume ${row.hcloud_volume_id}`,
              { error: err instanceof Error ? err.message : String(err) },
            );
          });
        }
      }
    }

    await containersRepository.delete(containerId, organizationId);
  }

  /** Restart a container in-place (`docker restart`). Status flips to `deploying`; the cron monitor confirms `running`. */
  async restartContainer(containerId: string, organizationId: string): Promise<ContainerSummary> {
    const row = await this.requireRowWithMeta(containerId, organizationId);
    const { meta } = row;

    await this.execOnNode(meta, (ssh) =>
      ssh.exec(`docker restart ${shellQuote(meta.containerName)}`, 30_000),
    );

    const updated = await containersRepository.update(containerId, organizationId, {
      status: "deploying",
      deployment_log: "Container restarted; waiting for health check...",
    });
    return rowToSummary(updated ?? row.row);
  }

  /**
   * Replace the env var set on a container. Implemented as
   * `docker stop` + `docker rm` + `docker create` with the new env, then
   * `docker start`. Same pattern Docker itself uses since env vars cannot
   * be mutated on a running container.
   */
  async setEnv(
    containerId: string,
    organizationId: string,
    environmentVars: Record<string, string>,
  ): Promise<ContainerSummary> {
    for (const key of Object.keys(environmentVars)) validateEnvKey(key);
    const row = await this.requireRowWithMeta(containerId, organizationId);
    const { meta } = row;

    await this.execOnNode(meta, async (ssh) => {
      await ssh.exec(`docker stop -t 10 ${shellQuote(meta.containerName)}`, 30_000).catch(() => {});
      await ssh.exec(`docker rm -f ${shellQuote(meta.containerName)}`, 30_000);

      const envFlags = Object.entries(environmentVars)
        .map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`)
        .join(" ");

      await ssh.exec(
        [
          "docker create",
          `--name ${shellQuote(meta.containerName)}`,
          "--restart unless-stopped",
          `--network ${shellQuote(DEFAULT_NODE_NETWORK)}`,
          `--memory ${row.row.memory}m`,
          ...(meta.volumePath ? [`-v ${shellQuote(meta.volumePath)}:/data`] : []),
          `-p ${meta.hostPort}:${meta.containerPort}`,
          envFlags,
          shellQuote(meta.image),
        ]
          .filter(Boolean)
          .join(" "),
        60_000,
      );
      await ssh.exec(`docker start ${shellQuote(meta.containerName)}`, 60_000);
    });

    const updated = await containersRepository.update(containerId, organizationId, {
      environment_vars: environmentVars,
      status: "deploying",
      deployment_log: "Env vars updated; container recreated. Waiting for health check...",
    });
    return rowToSummary(updated ?? row.row);
  }

  /**
   * Multi-replica scale is not supported on the shared Docker pool;
   * accept only `desiredCount === 1` and treat anything else as an
   * `invalid_input` error. Kept on the interface so the route layer can
   * 400 cleanly without a missing-method catch.
   */
  async setScale(
    _containerId: string,
    _organizationId: string,
    desiredCount: number,
  ): Promise<void> {
    if (desiredCount === 1) return;
    throw new HetznerClientError(
      "invalid_input",
      `desiredCount must be 1; multi-replica containers are not supported on the Hetzner-Docker pool.`,
    );
  }

  // ----------------------------------------------------------------------
  // Observability
  // ----------------------------------------------------------------------

  /**
   * Fetch the last `tailLines` lines of container logs. Returns plain
   * text, line-delimited; the route layer streams it back to the client.
   *
   * Streaming (`docker logs --follow`) is intentionally NOT implemented
   * here — that requires holding an open SSH channel for the duration
   * of the client's connection, which doesn't compose well with
   * serverless. Keep streaming on the Node sidecar path until the API
   * route has an SSE adapter.
   */
  async tailLogs(containerId: string, organizationId: string, tailLines = 200): Promise<string> {
    if (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > 10_000) {
      throw new HetznerClientError("invalid_input", "tailLines must be 1..10000");
    }
    const row = await this.requireRowWithMeta(containerId, organizationId);
    const { meta } = row;

    return this.execOnNode(meta, (ssh) =>
      ssh.exec(`docker logs --tail ${tailLines} ${shellQuote(meta.containerName)} 2>&1`, 30_000),
    );
  }

  /**
   * Stream container logs (`docker logs --follow`) over an SSH channel.
   * The caller receives chunks as they arrive and is responsible for
   * forwarding them to the user (typically as Server-Sent Events).
   *
   * The AbortSignal MUST be fired when the client disconnects so the
   * remote `docker logs -f` process is terminated. Otherwise the SSH
   * channel stays open and accrues SSH-pool slots indefinitely.
   */
  async streamLogs(
    containerId: string,
    organizationId: string,
    handlers: {
      onStdout: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      signal: AbortSignal;
      tailLines?: number;
    },
  ): Promise<void> {
    const tailLines = handlers.tailLines ?? 100;
    if (!Number.isInteger(tailLines) || tailLines < 0 || tailLines > 10_000) {
      throw new HetznerClientError("invalid_input", "tailLines must be 0..10000");
    }
    const row = await this.requireRowWithMeta(containerId, organizationId);
    const { meta } = row;

    await this.execOnNode(meta, async (ssh) => {
      await ssh.execStream(
        `docker logs --follow --tail ${tailLines} ${shellQuote(meta.containerName)} 2>&1`,
        {
          onStdout: handlers.onStdout,
          onStderr: handlers.onStderr,
          signal: handlers.signal,
        },
      );
    });
  }

  /**
   * Snapshot CPU / memory / net / block I/O via `docker stats --no-stream`.
   * Not a time series — callers that want one need to poll. CloudWatch's
   * built-in 1-min granularity series is not available on Docker.
   */
  async getMetrics(containerId: string, organizationId: string): Promise<ContainerMetricsSnapshot> {
    const row = await this.requireRowWithMeta(containerId, organizationId);
    const { meta } = row;

    // Format: container, cpu_perc, mem_usage/limit, net_io, block_io
    // We use a strict format string so the parse below stays simple.
    const raw = await this.execOnNode(meta, (ssh) =>
      ssh.exec(
        `docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}' ${shellQuote(meta.containerName)}`,
        15_000,
      ),
    );

    return parseDockerStats(raw);
  }

  // ----------------------------------------------------------------------
  // Health monitor (used by deployment-monitor cron)
  // ----------------------------------------------------------------------

  /**
   * Inspect the Docker health status of every container in
   * (`building`, `deploying`) and flip `running` / `failed` accordingly.
   * Called from the deployment-monitor cron handler.
   */
  async monitorInflight(): Promise<{ checked: number; running: number; failed: number }> {
    const inflight = await dbRead
      .select()
      .from(containersTable)
      .where(eq(containersTable.status, "deploying"));

    let running = 0;
    let failed = 0;

    for (const row of inflight) {
      const meta = readMetadata(row);
      if (!meta) continue; // not a hetzner-docker container; skip

      try {
        const status = (
          await this.execOnNode(meta, (ssh) =>
            ssh.exec(
              `docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ${shellQuote(meta.containerName)}`,
              15_000,
            ),
          )
        ).trim();

        if (status === "healthy" || status === "running") {
          const checkedAt = new Date();
          await dbWrite
            .update(containersTable)
            .set({
              status: "running",
              deployment_log: `Container is running on ${meta.nodeId}.`,
              error_message: null,
              last_deployed_at: checkedAt,
              last_health_check: checkedAt,
              updated_at: checkedAt,
            })
            .where(eq(containersTable.id, row.id));
          running += 1;
        } else if (status === "exited" || status === "dead") {
          const checkedAt = new Date();
          await dbWrite
            .update(containersTable)
            .set({
              status: "failed",
              deployment_log: `Container is ${status}.`,
              error_message: `Container is ${status}`,
              last_health_check: checkedAt,
              updated_at: checkedAt,
            })
            .where(eq(containersTable.id, row.id));
          failed += 1;
        }
        // else still starting — leave alone
      } catch (err) {
        logger.warn(`[hetzner-client] monitor probe failed for ${row.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { checked: inflight.length, running, failed };
  }

  // ----------------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------------

  private async requireRowWithMeta(
    containerId: string,
    organizationId: string,
  ): Promise<{ row: Container; meta: HetznerContainerMetadata }> {
    const row = await containersRepository.findById(containerId, organizationId);
    if (!row) {
      throw new HetznerClientError("container_not_found", `container ${containerId} not found`);
    }
    const meta = readMetadata(row);
    if (!meta) {
      throw new HetznerClientError(
        "container_not_found",
        `container ${containerId} has no Hetzner backend metadata (legacy AWS row?)`,
      );
    }
    return { row, meta };
  }

  private async execOnNode<T>(
    meta: HetznerContainerMetadata,
    fn: (ssh: DockerSSHClient) => Promise<T>,
  ): Promise<T> {
    const node = await dockerNodesRepository.findByNodeId(meta.nodeId);
    const hostname = node?.hostname ?? meta.hostname;
    const ssh = DockerSSHClient.getClient(
      hostname,
      node?.ssh_port ?? 22,
      node?.host_key_fingerprint ?? undefined,
      node?.ssh_user ?? "root",
    );
    try {
      return await fn(ssh);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // SSH connection-level failures are reclassified so the route layer
      // can return a 503 instead of a 500.
      if (
        message.includes("ECONNREFUSED") ||
        message.includes("ETIMEDOUT") ||
        message.includes("connect timeout")
      ) {
        throw new HetznerClientError("ssh_unreachable", message, err);
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse the output of `docker stats --no-stream --format ...`. */
export function parseDockerStats(raw: string): ContainerMetricsSnapshot {
  const trimmed = raw.trim().split("\n").pop() ?? "";
  const [cpuPerc, memUsage, netIo, blockIo] = trimmed.split("|");
  if (!cpuPerc || !memUsage || !netIo || !blockIo) {
    throw new HetznerClientError(
      "invalid_input",
      `Failed to parse docker stats output: ${raw.slice(0, 200)}`,
    );
  }

  const cpuPercent = parseFloat(cpuPerc.replace("%", ""));
  const [memUsedRaw, memLimitRaw] = memUsage.split("/").map((s) => s.trim());
  const memoryBytes = parseSize(memUsedRaw);
  const memoryLimitBytes = parseSize(memLimitRaw);
  const [netRxRaw, netTxRaw] = netIo.split("/").map((s) => s.trim());
  const [blockReadRaw, blockWriteRaw] = blockIo.split("/").map((s) => s.trim());

  return {
    cpuPercent,
    memoryBytes,
    memoryLimitBytes,
    netRxBytes: parseSize(netRxRaw),
    netTxBytes: parseSize(netTxRaw),
    blockReadBytes: parseSize(blockReadRaw),
    blockWriteBytes: parseSize(blockWriteRaw),
    capturedAt: new Date(),
  };
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_024 ** 2,
  gib: 1_024 ** 3,
  tib: 1_024 ** 4,
};

function parseSize(raw: string): number {
  const match = raw.match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;
  const [, n, unit] = match;
  const multiplier = unit ? (SIZE_UNITS[unit.toLowerCase()] ?? 1) : 1;
  return Math.round(parseFloat(n) * multiplier);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: HetznerContainersClient | null = null;

export function getHetznerContainersClient(): HetznerContainersClient {
  if (!instance) instance = new HetznerContainersClient();
  return instance;
}

// `LogChunk` is exported above as a type. The default streaming surface
// uses `tailLogs()` returning plain text; SSE-based streaming will be
// added on the Node sidecar that hosts these routes.
export type { Container, NewContainer };
