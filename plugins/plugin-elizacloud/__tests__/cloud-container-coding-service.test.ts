import { describe, expect, it } from "vitest";
import { CloudContainerService } from "../src/services/cloud-container";
import type {
  PromoteVfsToCloudContainerRequest,
  RequestCodingAgentContainerRequest,
  SyncCloudCodingContainerRequest,
} from "../src/types/cloud";

function serviceWithClient(client: { post: (path: string, body: unknown) => Promise<unknown> }) {
  const service = new CloudContainerService({} as never);
  (service as unknown as { authService: unknown }).authService = {
    isAuthenticated: () => true,
    getClient: () => client,
  };
  return service;
}

describe("CloudContainerService coding-container methods", () => {
  it("posts VFS promotion requests to the coding-container promotion endpoint", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const request: PromoteVfsToCloudContainerRequest = {
      preferredAgent: "codex",
      source: {
        sourceKind: "project",
        projectId: "project-1",
        snapshotId: "snapshot-1",
        files: [{ path: "README.md", contents: "# Project", encoding: "utf-8" }],
      },
    };
    const service = serviceWithClient({
      post: async (path, body) => {
        calls.push({ path, body });
        return {
          success: true,
          data: {
            promotionId: "promo-real",
            status: "accepted",
            source: request.source,
            workspacePath: "/workspace",
            createdAt: "2026-05-11T00:00:00.000Z",
          },
        };
      },
    });

    const response = await service.promoteVfsToCloudContainer(request);

    expect(calls).toEqual([{ path: "/coding-containers/promotions", body: request }]);
    expect(response).toMatchObject({
      success: true,
      data: { promotionId: "promo-real", status: "accepted" },
    });
  });

  it("posts coding-agent container requests with requested agent and promotion id", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const request: RequestCodingAgentContainerRequest = {
      agent: "opencode",
      promotionId: "promo-1",
      prompt: "Implement the mobile shell hook",
      container: {
        cpu: 2048,
        memory: 4096,
        environmentVars: { ELIZA_CODING_AGENT: "opencode" },
      },
    };
    const service = serviceWithClient({
      post: async (path, body) => {
        calls.push({ path, body });
        return {
          success: true,
          data: {
            containerId: "container-real",
            status: "requested",
            agent: "opencode",
            promotionId: "promo-1",
            workspacePath: "/workspace",
            createdAt: "2026-05-11T00:00:00.000Z",
          },
        };
      },
    });

    await service.requestCodingAgentContainer(request);

    expect(calls).toEqual([{ path: "/coding-containers", body: request }]);
  });

  it("posts sync requests to the container-specific sync endpoint", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const request: SyncCloudCodingContainerRequest = {
      direction: "pull",
      target: { sourceKind: "project", projectId: "project-1", baseRevision: "rev-before" },
      changedFiles: [{ path: "src/app.ts", contents: "export const ok = true;" }],
      patches: [{ path: "src/app.ts", format: "unified-diff", patch: "@@ -1 +1" }],
    };
    const service = serviceWithClient({
      post: async (path, body) => {
        calls.push({ path, body });
        return {
          success: true,
          data: {
            syncId: "sync-real",
            containerId: "container/real",
            status: "ready",
            direction: "pull",
            target: request.target,
            changedFiles: request.changedFiles,
            deletedFiles: [],
            patches: request.patches,
            createdAt: "2026-05-11T00:00:00.000Z",
          },
        };
      },
    });

    await service.syncCodingContainerChanges("container/real", request);

    expect(calls).toEqual([
      {
        path: "/coding-containers/container%2Freal/sync",
        body: request,
      },
    ]);
  });

  it("fails closed when cloud auth is unavailable", async () => {
    const service = new CloudContainerService({} as never);

    await expect(
      service.requestCodingAgentContainer({
        agent: "claude",
        promotionId: "promo-1",
      })
    ).rejects.toMatchObject({
      message: "Cloud auth is not connected",
      statusCode: 503,
    });
  });

  it("fails closed for missing backend coding-container endpoints", async () => {
    const service = serviceWithClient({
      post: async () => {
        throw { statusCode: 501 };
      },
    });

    await expect(
      service.promoteVfsToCloudContainer({
        source: {
          sourceKind: "workspace",
          workspaceId: "workspace-1",
          manifest: { fileCount: 3, totalBytes: 120 },
        },
      })
    ).rejects.toMatchObject({
      message: "Eliza Cloud coding-container promotion endpoint is not deployed yet",
      statusCode: 503,
    });
  });
});
