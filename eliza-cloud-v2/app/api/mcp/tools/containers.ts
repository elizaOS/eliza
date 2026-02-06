/**
 * Container MCP tools
 * Tools for managing deployed containers
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { containersService } from "@/lib/services/containers";
import { getContainer, deleteContainer } from "@/lib/services/containers";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerContainerTools(server: McpServer): void {
  // List Containers
  server.registerTool(
    "list_containers",
    {
      description: "List all deployed containers with status. FREE tool.",
      inputSchema: {
        status: z
          .enum(["running", "stopped", "failed", "deploying"])
          .optional(),
        includeMetrics: z.boolean().optional().default(false),
      },
    },
    async ({ status }) => {
      try {
        const { user } = getAuthContext();
        let containers = await containersService.listByOrganization(
          user.organization_id,
        );

        if (status) {
          containers = containers.filter((c) => c.status === status);
        }

        const formattedContainers = containers.map(
          (container: (typeof containers)[0]) => ({
            id: container.id,
            name: container.name,
            status: container.status,
            url: container.load_balancer_url,
            createdAt: container.created_at,
            errorMessage: container.error_message,
            ecsServiceArn: container.ecs_service_arn,
          }),
        );

        return jsonResponse({
          success: true,
          containers: formattedContainers,
          total: formattedContainers.length,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to list containers",
        );
      }
    },
  );

  // Get Container
  server.registerTool(
    "get_container",
    {
      description: "Get container details. FREE tool.",
      inputSchema: {
        containerId: z.string().uuid().describe("Container ID"),
      },
    },
    async ({ containerId }) => {
      try {
        const { user } = getAuthContext();
        const container = await getContainer(containerId, user.organization_id);
        if (!container) throw new Error("Container not found");

        return jsonResponse({
          success: true,
          container: {
            id: container.id,
            name: container.name,
            status: container.status,
            url: container.load_balancer_url,
          },
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to get container",
        );
      }
    },
  );

  // Get Container Health
  server.registerTool(
    "get_container_health",
    {
      description: "Get container health status. FREE tool.",
      inputSchema: {
        containerId: z.string().uuid().describe("Container ID"),
      },
    },
    async ({ containerId }) => {
      try {
        const { user } = getAuthContext();
        const container = await getContainer(containerId, user.organization_id);
        if (!container) throw new Error("Container not found");

        return jsonResponse({
          success: true,
          healthy: container.status === "running",
          status: container.status,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to get container health",
        );
      }
    },
  );

  // Get Container Logs
  server.registerTool(
    "get_container_logs",
    {
      description: "Get container logs. FREE tool.",
      inputSchema: {
        containerId: z.string().uuid().describe("Container ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(50)
          .describe("Max log entries"),
      },
    },
    async ({ containerId, limit }) => {
      try {
        const { user } = getAuthContext();
        const container = await getContainer(containerId, user.organization_id);
        if (!container) throw new Error("Container not found");

        return jsonResponse({
          success: true,
          logs: [`Container ${containerId} status: ${container.status}`],
          limit,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to get container logs",
        );
      }
    },
  );

  // Create Container
  server.registerTool(
    "create_container",
    {
      description:
        "Create and deploy a container. Cost: $0.50 deployment + $0.67/day running (~$20/month)",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Container name"),
        ecrImageUri: z.string().describe("ECR image URI"),
        projectName: z.string().min(1).max(50).describe("Project name"),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .default(3000)
          .describe("Port"),
        cpu: z
          .number()
          .int()
          .min(256)
          .max(2048)
          .optional()
          .default(1792)
          .describe("CPU units"),
        memory: z
          .number()
          .int()
          .min(256)
          .max(2048)
          .optional()
          .default(1792)
          .describe("Memory MB"),
        environmentVars: z
          .record(z.string())
          .optional()
          .describe("Environment variables"),
      },
    },
    async ({
      name,
      ecrImageUri,
      projectName,
      port,
      cpu,
      memory,
      environmentVars,
    }) => {
      try {
        const { user } = getAuthContext();
        const DEPLOYMENT_COST = 10;

        // Validate ECR URI before reserving credits to avoid credit leaks
        const [repositoryUri, imageTag] = ecrImageUri.split(":");
        if (!imageTag) {
          throw new Error("ECR image URI must include a tag");
        }

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: DEPLOYMENT_COST,
            userId: user.id,
            description: `MCP container deployment: ${name}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            throw new Error(`Insufficient credits: need $${DEPLOYMENT_COST}`);
          }
          throw error;
        }

        let container;
        try {
          container = await containersService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            name,
            project_name: projectName,
            ecr_repository_uri: repositoryUri,
            ecr_image_tag: imageTag,
            image_tag: imageTag,
            port,
            cpu,
            memory,
            environment_vars: environmentVars || {},
            status: "deploying",
            metadata: {
              ecr_image_uri: ecrImageUri,
            },
          });
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(DEPLOYMENT_COST);

        return jsonResponse({
          success: true,
          containerId: container.id,
          name: container.name,
          status: container.status,
          cost: DEPLOYMENT_COST,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to create container",
        );
      }
    },
  );

  // Delete Container
  server.registerTool(
    "delete_container",
    {
      description: "Delete a container. FREE tool.",
      inputSchema: {
        containerId: z.string().uuid().describe("Container ID to delete"),
      },
    },
    async ({ containerId }) => {
      try {
        const { user } = getAuthContext();
        const container = await getContainer(containerId, user.organization_id);
        if (!container) throw new Error("Container not found");

        await deleteContainer(containerId, user.organization_id);
        return jsonResponse({ success: true, containerId });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to delete container",
        );
      }
    },
  );

  // Get Container Metrics
  server.registerTool(
    "get_container_metrics",
    {
      description: "Get container metrics. FREE tool.",
      inputSchema: {
        containerId: z.string().uuid().describe("Container ID"),
      },
    },
    async ({ containerId }) => {
      try {
        const { user } = getAuthContext();
        const container = await getContainer(containerId, user.organization_id);
        if (!container) throw new Error("Container not found");

        return jsonResponse({
          success: true,
          metrics: {
            containerId,
            status: container.status,
            cpu: container.cpu,
            memory: container.memory,
            createdAt: container.created_at,
          },
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to get container metrics",
        );
      }
    },
  );

  // Get Container Quota
  server.registerTool(
    "get_container_quota",
    {
      description: "Get container quota. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const containers = await containersService.listByOrganization(
          user.organization_id,
        );

        return jsonResponse({
          success: true,
          quota: {
            used: containers.length,
            limit: 5,
            remaining: Math.max(0, 5 - containers.length),
          },
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to get container quota",
        );
      }
    },
  );
}
