/**
 * Hetzner Containers Client — public barrel.
 *
 * The implementation is split across `./hetzner-client/`. This file
 * re-exports the public API in the same shape callers expect; no logic
 * lives here. See:
 *
 *   - `client.ts`       — `HetznerContainersClient` + singleton accessor
 *   - `types.ts`        — DTOs, metadata, and `HetznerClientError`
 *   - `paths.ts`        — container/host/volume path derivation + input validators
 *   - `metadata.ts`     — container row → DTO mapping
 *   - `bootstrap.ts`    — bootstrap source + workspace sync filesystem ops
 *   - `scheduling.ts`   — sticky node pinning + Hetzner Cloud location matching
 *   - `registry.ts`     — image registry login + post-pull digest read
 *   - `docker-stats.ts` — parser for `docker stats --no-stream`
 *   - `constants.ts`    — shared internal constants
 *
 * Implementation notes preserved from the original file:
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

export type { Container, NewContainer } from "../../../db/repositories/containers";
export { getHetznerContainersClient, HetznerContainersClient } from "./hetzner-client/client";
export { parseDockerStats } from "./hetzner-client/docker-stats";
export {
  type ContainerBootstrapFile,
  type ContainerBootstrapSource,
  type ContainerMetricsSnapshot,
  type ContainerSummary,
  type ContainerWorkspaceSyncDirection,
  type ContainerWorkspaceSyncRequest,
  type ContainerWorkspaceSyncResult,
  type CreateContainerInput,
  HetznerClientError,
  type HetznerClientErrorCode,
  type HetznerContainerMetadata,
  type LogChunk,
} from "./hetzner-client/types";
