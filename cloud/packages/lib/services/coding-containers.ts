export type {
  CloudCodingContainerSession,
  CloudCodingContainerStatus,
  CloudCodingPromotion,
  CloudCodingSyncResult,
  PromoteVfsToCloudContainerRequest,
  PromoteVfsToCloudContainerResponse,
  RequestCodingAgentContainerRequest,
  RequestCodingAgentContainerResponse,
  SyncCloudCodingContainerRequest,
  SyncCloudCodingContainerResponse,
} from "../../../../packages/shared/src/contracts/cloud-coding-containers";
export {
  PromoteVfsToCloudContainerRequestSchema,
  RequestCodingAgentContainerRequestSchema,
  SyncCloudCodingContainerRequestSchema,
} from "../../../../packages/shared/src/contracts/cloud-coding-containers";

import { containersEnv } from "@/lib/config/containers-env";
import type {
  CloudCodingContainerSession,
  CloudCodingContainerStatus,
  CloudCodingPromotion,
  CloudCodingSyncResult,
  PromoteVfsToCloudContainerRequest,
  RequestCodingAgentContainerRequest,
  SyncCloudCodingContainerRequest,
} from "../../../../packages/shared/src/contracts/cloud-coding-containers";

export interface CodingContainerCreatePayload {
  name: string;
  project_name: string;
  description: string;
  image: string;
  port: number;
  desired_count: 1;
  cpu: number;
  memory: number;
  health_check_path: string;
  environment_vars: Record<string, string>;
  persist_volume: true;
  use_hetzner_volume: true;
  volume_size_gb: number;
}

export interface CodingContainerSessionBuildInput {
  request: RequestCodingAgentContainerRequest;
  createPayload: CodingContainerCreatePayload;
  upstreamData: Record<string, unknown>;
  now?: Date;
}

export interface CodingContainerPromotionBuildOptions {
  id?: string;
  now?: Date;
}

export interface CodingContainerSyncBuildOptions {
  id?: string;
  now?: Date;
}

const DEFAULT_CPU = 1792;
const DEFAULT_MEMORY_MB = 1792;
const DEFAULT_VOLUME_SIZE_GB = 10;

function trimOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slugify(value: string | undefined, fallback: string): string {
  const slug =
    value
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) ?? "";
  return slug || fallback;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function sourceSlug(request: RequestCodingAgentContainerRequest): string {
  const source = request.source;
  return slugify(
    request.promotionId ?? source?.projectId ?? source?.workspaceId ?? source?.snapshotId,
    "workspace",
  );
}

export function resolveCodingWorkspacePath(
  request: RequestCodingAgentContainerRequest,
  fallbackId = "workspace",
): string {
  return (
    trimOptional(request.workspacePath) ??
    trimOptional(request.source?.rootPath) ??
    `/workspace/${sourceSlug(request) || slugify(fallbackId, "workspace")}`
  );
}

export function buildCodingContainerCreatePayload(
  request: RequestCodingAgentContainerRequest,
): CodingContainerCreatePayload {
  const workspacePath = resolveCodingWorkspacePath(request);
  const projectName = slugify(
    request.container?.name ?? request.promotionId ?? request.source?.projectId,
    `coding-${request.agent}`,
  );
  const image = trimOptional(request.container?.image) ?? containersEnv.defaultAgentImage();
  const prompt = trimOptional(request.prompt);
  const promotionId = trimOptional(request.promotionId);

  const environmentVars: Record<string, string> = {
    ...(request.container?.environmentVars ?? {}),
    ELIZA_CLOUD_CODING_CONTAINER: "true",
    ELIZA_CODING_AGENT: request.agent,
    ELIZA_CLOUD_CODING_AGENT: request.agent,
    ELIZA_CODING_WORKSPACE: workspacePath,
  };

  if (promotionId) environmentVars.ELIZA_CODING_PROMOTION_ID = promotionId;
  if (prompt) environmentVars.ELIZA_CODING_PROMPT = prompt;

  return {
    name: slugify(request.container?.name, `coding-${request.agent}`),
    project_name: projectName,
    description: `Cloud coding container for ${request.agent}`,
    image,
    port: Number(containersEnv.agentPort()),
    desired_count: 1,
    cpu: request.container?.cpu ?? DEFAULT_CPU,
    memory: request.container?.memory ?? DEFAULT_MEMORY_MB,
    health_check_path: "/health",
    environment_vars: environmentVars,
    persist_volume: true,
    use_hetzner_volume: true,
    volume_size_gb: DEFAULT_VOLUME_SIZE_GB,
  };
}

function readString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeStatus(value: unknown): CloudCodingContainerStatus {
  if (value === "running" || value === "building" || value === "failed" || value === "stopped") {
    return value;
  }
  if (value === "pending" || value === "deploying") return "pending";
  return "requested";
}

export function buildCodingContainerSessionResponse({
  request,
  createPayload,
  upstreamData,
  now = new Date(),
}: CodingContainerSessionBuildInput): CloudCodingContainerSession {
  const containerId = readString(upstreamData, ["id", "containerId"]);
  if (!containerId) {
    throw new Error("Container control plane response did not include a container id");
  }

  return {
    containerId,
    status: normalizeStatus(upstreamData.status),
    agent: request.agent,
    ...(request.promotionId ? { promotionId: request.promotionId } : {}),
    workspacePath: resolveCodingWorkspacePath(request),
    url: readString(upstreamData, ["publicUrl", "load_balancer_url", "url"]) ?? null,
    createdAt: readString(upstreamData, ["createdAt", "created_at"]) ?? now.toISOString(),
    metadata: {
      image: createPayload.image,
      projectName: createPayload.project_name,
    },
  };
}

export function buildCodingPromotionResponse(
  request: PromoteVfsToCloudContainerRequest,
  options: CodingContainerPromotionBuildOptions = {},
): CloudCodingPromotion {
  const promotionId = options.id ?? randomId("ccpromo");
  const sourceName =
    request.source.projectId ?? request.source.workspaceId ?? request.source.snapshotId;
  const workspacePath =
    trimOptional(request.target?.workspacePath) ??
    trimOptional(request.source.rootPath) ??
    `/workspace/${slugify(sourceName, promotionId)}`;

  return {
    promotionId,
    status: "accepted",
    source: request.source,
    workspacePath,
    createdAt: (options.now ?? new Date()).toISOString(),
    metadata: {
      ...(request.metadata ?? {}),
      preferredAgent: request.preferredAgent ?? null,
      branchName: request.target?.branchName ?? null,
    },
  };
}

export function buildCodingSyncResponse(
  containerId: string,
  request: SyncCloudCodingContainerRequest,
  options: CodingContainerSyncBuildOptions = {},
): CloudCodingSyncResult {
  return {
    syncId: options.id ?? randomId("ccsync"),
    containerId,
    status: "accepted",
    direction: request.direction ?? "pull",
    target: request.target,
    changedFiles: request.changedFiles ?? [],
    deletedFiles: request.deletedFiles ?? [],
    patches: request.patches ?? [],
    createdAt: (options.now ?? new Date()).toISOString(),
    metadata: request.metadata,
  };
}
