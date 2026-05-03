import { ValidationError } from "@/lib/api/cloud-worker-errors";
import type { Container } from "@/lib/services/containers";

export interface ControlPlaneContainerMetrics {
  source: "control_plane";
  live: false;
  containerId: string;
  status: string;
  cpu: number;
  memory: number;
  desiredCount: number;
  port: number;
  lastHealthCheck: Date | null;
  lastDeployedAt: Date | null;
  updatedAt: Date;
  note: string;
}

export interface ControlPlaneContainerLogs {
  source: "control_plane";
  live: false;
  tail: number;
  text: string;
  updatedAt: Date;
  note: string;
}

export function parseTailParam(raw: string | undefined, defaultTail = 200): number {
  if (!raw) return defaultTail;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw ValidationError("tail must be an integer between 1 and 10000");
  }
  return value;
}

export function buildControlPlaneContainerMetrics(
  container: Container,
): ControlPlaneContainerMetrics {
  return {
    source: "control_plane",
    live: false,
    containerId: container.id,
    status: container.status,
    cpu: container.cpu,
    memory: container.memory,
    desiredCount: container.desired_count,
    port: container.port,
    lastHealthCheck: container.last_health_check,
    lastDeployedAt: container.last_deployed_at,
    updatedAt: container.updated_at,
    note: "Live Docker stats are collected by the Node sidecar; this Worker response is the authenticated control-plane state.",
  };
}

export function buildControlPlaneContainerLogs(
  container: Container,
  tail: number,
): ControlPlaneContainerLogs {
  const lines = (container.deployment_log ?? "").split(/\r?\n/);
  const text = lines.slice(-tail).join("\n");
  return {
    source: "control_plane",
    live: false,
    tail,
    text,
    updatedAt: container.updated_at,
    note: "Live Docker logs are collected by the Node sidecar; this Worker response is the latest deployment log persisted in the control plane.",
  };
}
