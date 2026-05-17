/**
 * Container row <-> DTO mapping.
 *
 * `readMetadata` parses the jsonb metadata blob; legacy AWS rows return
 * null. `rowToSummary` projects a `Container` row into the public
 * `ContainerSummary` shape returned to API callers.
 */

import type { Container } from "../../../../db/repositories/containers";
import type { ContainerSummary, HetznerContainerMetadata } from "./types";

/** Read the typed metadata blob off a container row, normalizing legacy AWS rows to null. */
export function readMetadata(row: Container): HetznerContainerMetadata | null {
  const raw = row.metadata as Record<string, unknown> | null | undefined;
  if (!raw || raw.provider !== "hetzner-docker") return null;
  if (
    typeof raw.nodeId !== "string" ||
    typeof raw.hostname !== "string" ||
    typeof raw.containerName !== "string" ||
    typeof raw.hostPort !== "number" ||
    typeof raw.image !== "string" ||
    typeof raw.containerPort !== "number"
  ) {
    return null;
  }
  return {
    provider: "hetzner-docker",
    nodeId: raw.nodeId,
    hostname: raw.hostname,
    containerName: raw.containerName,
    hostPort: raw.hostPort,
    image: raw.image,
    imageDigest: typeof raw.imageDigest === "string" ? raw.imageDigest : undefined,
    containerPort: raw.containerPort,
    volumePath: typeof raw.volumePath === "string" ? raw.volumePath : undefined,
    volumeMountPath: typeof raw.volumeMountPath === "string" ? raw.volumeMountPath : undefined,
  };
}

export function rowToSummary(row: Container): ContainerSummary {
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
