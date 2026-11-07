/**
 * The redacted container the public API returns: `{ success, data: ContainerDto }`
 * for list, get, create, update and stop. It never carries node metadata
 * (node id, host IP, host port, volume path), environment variables or
 * deployment logs.
 */
import type { Container } from "@elizaos/cloud-shared/lib/services/containers";
import type { ContainerSummary } from "@elizaos/cloud-shared/lib/services/containers/hetzner-client/types";

export interface ContainerDto {
  id: string;
  name: string;
  project_name: string;
  description: string | null;
  load_balancer_url: string | null;
  public_hostname: string | null;
  status: string;
  image_tag: string | null;
  desired_count: number | null;
  cpu: number | null;
  memory: number | null;
  port: number | null;
  health_check_path: string | null;
  last_deployed_at: string | null;
  last_health_check: string | null;
  error_message: string | null;
  billing_status: string | null;
  last_billed_at: string | null;
  next_billing_at: string | null;
  shutdown_warning_sent_at: string | null;
  scheduled_shutdown_at: string | null;
  total_billed: string | null;
  created_at: string;
  updated_at: string;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isContainerSummary(
  container: Container | ContainerSummary,
): container is ContainerSummary {
  return "projectName" in container;
}

export function toContainerDto(
  container: Container | ContainerSummary,
): ContainerDto {
  if (isContainerSummary(container)) {
    return {
      id: container.id,
      name: container.name,
      project_name: container.projectName,
      description: null,
      load_balancer_url: container.publicUrl,
      public_hostname: null,
      status: container.status,
      image_tag: container.image,
      desired_count: null,
      cpu: null,
      memory: null,
      port: null,
      health_check_path: null,
      last_deployed_at: null,
      last_health_check: null,
      error_message: container.errorMessage,
      billing_status: null,
      last_billed_at: null,
      next_billing_at: null,
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
      total_billed: null,
      created_at: container.createdAt.toISOString(),
      updated_at: container.updatedAt.toISOString(),
    };
  }

  return {
    id: container.id,
    name: container.name,
    project_name: container.project_name,
    description: container.description,
    load_balancer_url: container.load_balancer_url,
    public_hostname: container.public_hostname,
    status: container.status,
    image_tag: container.image_tag,
    desired_count: container.desired_count,
    cpu: container.cpu,
    memory: container.memory,
    port: container.port,
    health_check_path: container.health_check_path,
    last_deployed_at: isoOrNull(container.last_deployed_at),
    last_health_check: isoOrNull(container.last_health_check),
    error_message: container.error_message,
    billing_status: container.billing_status,
    last_billed_at: isoOrNull(container.last_billed_at),
    next_billing_at: isoOrNull(container.next_billing_at),
    shutdown_warning_sent_at: isoOrNull(container.shutdown_warning_sent_at),
    scheduled_shutdown_at: isoOrNull(container.scheduled_shutdown_at),
    total_billed: container.total_billed,
    created_at: container.created_at.toISOString(),
    updated_at: container.updated_at.toISOString(),
  };
}
