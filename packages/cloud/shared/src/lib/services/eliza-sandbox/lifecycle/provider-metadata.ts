/** Validates provider metadata before interpreting Docker replacement identity. */
import type { DockerSandboxMetadata } from "../../docker-sandbox-provider";

export function isDockerSandboxMetadata(value: unknown): value is DockerSandboxMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "docker" &&
    typeof (value as { nodeId?: unknown }).nodeId === "string" &&
    typeof (value as { hostname?: unknown }).hostname === "string" &&
    typeof (value as { containerName?: unknown }).containerName === "string"
  );
}

/**
 * True when a provider handle's metadata self-identifies as the real docker
 * fleet provider (`provider: "docker"`) — REGARDLESS of whether the rest of the
 * shape passes {@link isDockerSandboxMetadata}. This is deliberately laxer than
 * the full type guard: a docker-fleet container whose metadata drifts (a missing
 * field, an empty-string nodeId) still IS docker-backed and still occupies a
 * real node slot, even though the strict guard would reject it.
 *
 * Used to detect the C1b failure class (audit §C1b): a handle that is docker-
 * backed but for which we cannot recover a usable node_id. Such a row MUST NOT
 * be flipped to `running` (it would be an unattributable orphan the recount
 * undercounts and the orphan reconciler provably cannot reap — audit §C5).
 *
 * Non-docker providers (`local-docker`, `memory`) return false: they have no
 * node concept, so the attribution guard does not apply to them.
 */
export function isDockerBackedMetadata(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "docker"
  );
}
