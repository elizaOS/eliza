/**
 * CloudContainerService — Manages container lifecycle through ElizaCloud API.
 *
 * Handles creation, listing, status polling, health monitoring, and deletion
 * of ECS-backed containers. Deployments are async (CloudFormation takes 8-12
 * minutes), so `waitForDeployment` polls with exponential backoff.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  CloudContainer,
  ContainerDeleteResponse,
  ContainerGetResponse,
  ContainerHealthResponse,
  ContainerListResponse,
  CreateContainerRequest,
  CreateContainerResponse,
} from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import type { CloudApiClient } from "../utils/cloud-api";
import type { CloudAuthService } from "./cloud-auth";

/** Active containers tracked locally for quick access. */
interface TrackedContainer {
  container: CloudContainer;
  pollingTimer: ReturnType<typeof setTimeout> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
}

export class CloudContainerService extends Service {
  static serviceType = "CLOUD_CONTAINER";
  capabilityDescription = "ElizaCloud container provisioning and lifecycle management";

  private authService!: CloudAuthService;
  private readonly containerDefaults = DEFAULT_CLOUD_CONFIG.container;
  private tracked: Map<string, TrackedContainer> = new Map();

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudContainerService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    for (const [, tracked] of this.tracked) {
      if (tracked.pollingTimer) clearTimeout(tracked.pollingTimer);
      if (tracked.healthTimer) clearInterval(tracked.healthTimer);
    }
    this.tracked.clear();
  }

  private async initialize(): Promise<void> {
    // Get auth service reference
    const auth = this.runtime.getService("CLOUD_AUTH");
    if (!auth) {
      logger.debug(
        "[CloudContainer] CloudAuthService not available, container operations will fail"
      );
      return;
    }
    this.authService = auth as CloudAuthService;

    // Load existing containers
    if (this.authService.isAuthenticated()) {
      const containers = await this.listContainers();
      for (const container of containers) {
        this.tracked.set(container.id, {
          container,
          pollingTimer: null,
          healthTimer: null,
        });

        // Resume polling for containers that are still deploying
        if (
          container.status === "pending" ||
          container.status === "building" ||
          container.status === "deploying"
        ) {
          this.startPolling(container.id);
        }

        // Start health monitoring for running containers
        if (container.status === "running") {
          this.startHealthMonitoring(container.id);
        }
      }
      logger.info(`[CloudContainer] Loaded ${containers.length} existing container(s)`);
    }
  }

  private getClient(): CloudApiClient {
    return this.authService.getClient();
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────

  async createContainer(request: CreateContainerRequest): Promise<CreateContainerResponse> {
    const client = this.getClient();
    const defaults = this.containerDefaults;

    const payload: Record<string, unknown> = {
      name: request.name,
      project_name: request.project_name,
      description: request.description,
      port: request.port ?? defaults.defaultPort,
      desired_count: request.desired_count ?? 1,
      cpu: request.cpu ?? defaults.defaultCpu,
      memory: request.memory ?? defaults.defaultMemory,
      environment_vars: request.environment_vars ?? {},
      health_check_path: request.health_check_path ?? "/health",
      ecr_image_uri: request.ecr_image_uri,
      ecr_repository_uri: request.ecr_repository_uri,
      image_tag: request.image_tag,
      architecture: request.architecture ?? defaults.defaultArchitecture,
    };

    const response = await client.post<CreateContainerResponse>("/containers", payload);

    // Track the new container
    this.tracked.set(response.data.id, {
      container: response.data,
      pollingTimer: null,
      healthTimer: null,
    });

    // Start polling for deployment completion
    this.startPolling(response.data.id);

    logger.info(
      `[CloudContainer] Created container "${request.name}" (id=${response.data.id}, stack=${response.stackName})`
    );

    return response;
  }

  async listContainers(): Promise<CloudContainer[]> {
    const client = this.getClient();
    const response = await client.get<ContainerListResponse>("/containers");
    return response.data;
  }

  async getContainer(containerId: string): Promise<CloudContainer> {
    const client = this.getClient();
    const response = await client.get<ContainerGetResponse>(`/containers/${containerId}`);

    // Update local tracking
    const existing = this.tracked.get(containerId);
    if (existing) {
      existing.container = response.data;
    }

    return response.data;
  }

  async deleteContainer(containerId: string): Promise<void> {
    const client = this.getClient();
    await client.delete<ContainerDeleteResponse>(`/containers/${containerId}`);

    // Stop tracking
    const tracked = this.tracked.get(containerId);
    if (tracked) {
      if (tracked.pollingTimer) clearTimeout(tracked.pollingTimer);
      if (tracked.healthTimer) clearInterval(tracked.healthTimer);
      this.tracked.delete(containerId);
    }

    logger.info(`[CloudContainer] Deleted container ${containerId}`);
  }

  // ─── Deployment Polling ────────────────────────────────────────────────

  /**
   * Poll container status until it reaches a terminal state (running, failed, stopped).
   * Uses exponential backoff: 5s, 10s, 20s, 30s, 30s, ...
   */
  private startPolling(containerId: string): void {
    const tracked = this.tracked.get(containerId);
    if (!tracked) return;

    let attempt = 0;
    const maxAttempts = 120; // ~1 hour with backoff
    const baseInterval = 5_000;
    const maxInterval = 30_000;

    const poll = async () => {
      attempt++;
      if (attempt > maxAttempts) {
        logger.error(
          `[CloudContainer] Polling timed out for container ${containerId} after ${maxAttempts} attempts`
        );
        return;
      }

      const container = await this.getContainer(containerId);
      const status = container.status;

      logger.debug(`[CloudContainer] Poll #${attempt} for ${containerId}: status=${status}`);

      if (status === "running") {
        logger.info(
          `[CloudContainer] Container ${containerId} is now running at ${container.load_balancer_url}`
        );
        this.startHealthMonitoring(containerId);
        return;
      }

      if (status === "failed" || status === "stopped" || status === "suspended") {
        logger.warn(`[CloudContainer] Container ${containerId} reached terminal state: ${status}`);
        if (container.error_message) {
          logger.error(`[CloudContainer] Error: ${container.error_message}`);
        }
        return;
      }

      // Schedule next poll with exponential backoff
      const delay = Math.min(baseInterval * 2 ** Math.min(attempt - 1, 3), maxInterval);
      tracked.pollingTimer = setTimeout(poll, delay);
    };

    tracked.pollingTimer = setTimeout(poll, baseInterval);
  }

  /**
   * Wait for a container to reach "running" status. Returns the updated container.
   * This is the synchronous API for actions that need to block.
   */
  async waitForDeployment(containerId: string, timeoutMs = 900_000): Promise<CloudContainer> {
    const deadline = Date.now() + timeoutMs;
    let interval = 5_000;
    const maxInterval = 30_000;

    while (Date.now() < deadline) {
      const container = await this.getContainer(containerId);

      if (container.status === "running") return container;
      if (container.status === "failed") {
        throw new Error(
          `Container deployment failed: ${container.error_message ?? "unknown error"}`
        );
      }
      if (container.status === "stopped" || container.status === "suspended") {
        throw new Error(`Container reached terminal state: ${container.status}`);
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 1.5, maxInterval);
    }

    throw new Error(`Container deployment timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  // ─── Health Monitoring ─────────────────────────────────────────────────

  private startHealthMonitoring(containerId: string): void {
    const tracked = this.tracked.get(containerId);
    if (!tracked || tracked.healthTimer) return;

    const interval = 60_000; // Check every 60 seconds

    tracked.healthTimer = setInterval(() => {
      this.getContainerHealth(containerId)
        .then((health) => {
          if (!health.data.healthy) {
            logger.warn(
              `[CloudContainer] Container ${containerId} unhealthy: ${health.data.status}`
            );
          }
        })
        .catch((err: Error) => {
          logger.error(`[CloudContainer] Health check failed for ${containerId}: ${err.message}`);
        });
    }, interval);
  }

  async getContainerHealth(containerId: string): Promise<ContainerHealthResponse> {
    const client = this.getClient();
    return client.get<ContainerHealthResponse>(`/containers/${containerId}/health`);
  }

  // ─── Accessors ─────────────────────────────────────────────────────────

  getTrackedContainers(): CloudContainer[] {
    return Array.from(this.tracked.values()).map((t) => t.container);
  }

  getTrackedContainer(containerId: string): CloudContainer | undefined {
    return this.tracked.get(containerId)?.container;
  }

  isContainerRunning(containerId: string): boolean {
    return this.tracked.get(containerId)?.container.status === "running";
  }

  getContainerUrl(containerId: string): string | null {
    return this.tracked.get(containerId)?.container.load_balancer_url ?? null;
  }
}
