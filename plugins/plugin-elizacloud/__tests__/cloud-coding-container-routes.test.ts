import type http from "node:http";
import { describe, expect, it } from "vitest";
import { handleCloudCodingContainerRoute } from "../src/routes/cloud-coding-container-routes";
import type {
  PromoteVfsToCloudContainerRequest,
  RequestCodingAgentContainerRequest,
  SyncCloudCodingContainerRequest,
} from "../src/types/cloud";

function requestWithBody(body: unknown): http.IncomingMessage {
  return {
    body,
    headers: {},
    method: "POST",
    url: "/",
  } as http.IncomingMessage & { body: unknown };
}

function responseSink(): http.ServerResponse & { jsonBody: () => unknown } {
  let body = "";
  const sink = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: unknown) => {
      body = typeof chunk === "string" ? chunk : String(chunk ?? "");
      sink.headersSent = true;
      return {} as http.ServerResponse;
    },
    jsonBody: () => JSON.parse(body),
  };
  return sink as http.ServerResponse & { jsonBody: () => unknown };
}

describe("cloud coding-container routes", () => {
  it("forwards VFS promotion requests to the cloud container service", async () => {
    let captured: PromoteVfsToCloudContainerRequest | null = null;
    const service = {
      promoteVfsToCloudContainer: async (request: PromoteVfsToCloudContainerRequest) => {
        captured = request;
        return {
          success: true,
          data: {
            promotionId: "promo-1",
            status: "accepted" as const,
            source: request.source,
            workspacePath: "/workspace",
            createdAt: "2026-05-11T00:00:00.000Z",
          },
        };
      },
      requestCodingAgentContainer: async () => {
        throw new Error("unexpected");
      },
      syncCodingContainerChanges: async () => {
        throw new Error("unexpected");
      },
    };
    const runtime = { getService: () => service };
    const request: PromoteVfsToCloudContainerRequest = {
      preferredAgent: "codex",
      source: {
        sourceKind: "project",
        projectId: "vfs-project-1",
        revision: "rev-1",
        files: [{ path: "src/index.ts", contents: "export {};", encoding: "utf-8" }],
      },
    };
    const response = responseSink();

    const handled = await handleCloudCodingContainerRoute(
      requestWithBody(request),
      response,
      "/api/cloud/coding-containers/promotions",
      "POST",
      { runtime: runtime as never }
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(captured).toEqual(request);
    expect(response.jsonBody()).toMatchObject({
      success: true,
      data: { promotionId: "promo-1", workspacePath: "/workspace" },
    });
  });

  it("forwards coding-agent container requests with Claude/Codex/OpenCode agent ids", async () => {
    let captured: RequestCodingAgentContainerRequest | null = null;
    const service = {
      promoteVfsToCloudContainer: async () => {
        throw new Error("unexpected");
      },
      requestCodingAgentContainer: async (request: RequestCodingAgentContainerRequest) => {
        captured = request;
        return {
          success: true,
          data: {
            containerId: "cc-1",
            status: "requested" as const,
            agent: request.agent,
            promotionId: request.promotionId,
            workspacePath: "/workspace",
            createdAt: "2026-05-11T00:00:00.000Z",
          },
        };
      },
      syncCodingContainerChanges: async () => {
        throw new Error("unexpected");
      },
    };
    const runtime = { getService: () => service };
    const request: RequestCodingAgentContainerRequest = {
      agent: "claude",
      promotionId: "promo-1",
      prompt: "Fix the failing test",
    };
    const response = responseSink();

    await handleCloudCodingContainerRoute(
      requestWithBody(request),
      response,
      "/api/cloud/coding-containers",
      "POST",
      { runtime: runtime as never }
    );

    expect(captured).toEqual(request);
    expect(response.jsonBody()).toMatchObject({
      success: true,
      data: { containerId: "cc-1", agent: "claude", promotionId: "promo-1" },
    });
  });

  it("forwards sync requests with decoded container ids", async () => {
    let capturedContainerId: string | null = null;
    let capturedRequest: SyncCloudCodingContainerRequest | null = null;
    const service = {
      promoteVfsToCloudContainer: async () => {
        throw new Error("unexpected");
      },
      requestCodingAgentContainer: async () => {
        throw new Error("unexpected");
      },
      syncCodingContainerChanges: async (
        containerId: string,
        request: SyncCloudCodingContainerRequest
      ) => {
        capturedContainerId = containerId;
        capturedRequest = request;
        return {
          success: true,
          data: {
            syncId: "sync-1",
            containerId,
            status: "ready" as const,
            direction: request.direction ?? "pull",
            target: request.target,
            changedFiles: request.changedFiles ?? [],
            deletedFiles: request.deletedFiles ?? [],
            patches: request.patches ?? [],
            createdAt: "2026-05-11T00:00:00.000Z",
          },
        };
      },
    };
    const runtime = { getService: () => service };
    const request: SyncCloudCodingContainerRequest = {
      direction: "pull",
      target: { sourceKind: "workspace", workspaceId: "workspace-1", baseRevision: "rev-1" },
      patches: [{ path: "src/index.ts", format: "unified-diff", patch: "@@ test" }],
    };
    const response = responseSink();

    await handleCloudCodingContainerRoute(
      requestWithBody(request),
      response,
      "/api/cloud/coding-containers/container%2Fone/sync",
      "POST",
      { runtime: runtime as never }
    );

    expect(capturedContainerId).toBe("container/one");
    expect(capturedRequest).toEqual(request);
    expect(response.jsonBody()).toMatchObject({
      success: true,
      data: { syncId: "sync-1", containerId: "container/one" },
    });
  });

  it("rejects malformed request shapes before hitting the service", async () => {
    const response = responseSink();
    const runtime = {
      getService: () => ({
        promoteVfsToCloudContainer: async () => {
          throw new Error("should not be called");
        },
        requestCodingAgentContainer: async () => {
          throw new Error("should not be called");
        },
        syncCodingContainerChanges: async () => {
          throw new Error("should not be called");
        },
      }),
    };

    await handleCloudCodingContainerRoute(
      requestWithBody({ agent: "gemini", promotionId: "promo-1" }),
      response,
      "/api/cloud/coding-containers",
      "POST",
      { runtime: runtime as never }
    );

    expect(response.statusCode).toBe(400);
    expect(response.jsonBody()).toEqual({
      error: 'Invalid option: expected one of "claude"|"codex"|"opencode"',
    });
  });
});
