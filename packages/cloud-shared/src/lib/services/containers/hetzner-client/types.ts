/**
 * Hetzner Containers — types and error class.
 *
 * Public DTOs and the normalized error shape the route layer maps to HTTP
 * status codes. No runtime logic here.
 */

import type { Container } from "../../../../db/repositories/containers";

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

  /** Container path where the persistent project volume is mounted. Defaults to `/data`. */
  volumeMountPath?: string;

  /** Optional file bundle written into the persistent volume before container start. */
  bootstrapSource?: ContainerBootstrapSource;
}

export interface ContainerBootstrapFile {
  path: string;
  contents: string;
  encoding?: "utf-8" | "base64";
  size?: number;
  sha256?: string;
  mode?: string;
  mtimeMs?: number;
}

export interface ContainerBootstrapSource {
  sourceKind?: "project" | "workspace";
  projectId?: string;
  workspaceId?: string;
  rootPath?: string;
  snapshotId?: string;
  revision?: string;
  files?: ContainerBootstrapFile[];
  deletedFiles?: Array<{ path: string; sha256?: string }>;
  manifest?: {
    fileCount?: number;
    totalBytes?: number;
    ignoredPaths?: string[];
  };
  metadata?: Record<string, unknown>;
}

export type ContainerWorkspaceSyncDirection = "pull" | "push" | "roundtrip";

export interface ContainerWorkspaceSyncRequest {
  direction?: ContainerWorkspaceSyncDirection;
  changedFiles?: ContainerBootstrapFile[];
  deletedFiles?: Array<{ path: string; sha256?: string }>;
  patches?: Array<{ path: string; format: string; patch: string }>;
  metadata?: Record<string, unknown>;
}

export interface ContainerWorkspaceSyncResult {
  status: "applied" | "ready";
  direction: ContainerWorkspaceSyncDirection;
  changedFiles: ContainerBootstrapFile[];
  deletedFiles: Array<{ path: string; sha256?: string }>;
  patches: Array<{ path: string; format: string; patch: string }>;
  metadata?: Record<string, unknown>;
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
  /** Repo digest resolved by Docker after pull, when available. */
  imageDigest?: string;
  /** Application port inside the container. */
  containerPort: number;
  /** Host filesystem path mounted at `/data` inside the container, if persistent. */
  volumePath?: string;
  /** Container path receiving the persistent volume. Legacy rows default to `/data`. */
  volumeMountPath?: string;
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
