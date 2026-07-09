/**
 * Route-level contract for the authenticated Files surface: GET /api/files
 * sorts the content-addressed store newest-first and returns the viewer-aware
 * restricted DTO for non-privileged callers. The storage service is a fake; the
 * route handler and access-context plumbing are real.
 */
import type {
  AccessContext,
  IAgentRuntime,
  RouteHandlerContext,
  StoredFileListItem,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { fileDeleteRoute, filesListRoute } from "./files-routes.ts";

const REMOTE_FILES = "aws_s3";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

const FILES: StoredFileListItem[] = [
  {
    url: "/api/media/new.png",
    hash: "new",
    fileName: "new.png",
    mimeType: "image/png",
    size: 10,
    createdAt: 2,
  },
  {
    url: "/api/media/old.pdf",
    hash: "old",
    fileName: "old.pdf",
    mimeType: "application/pdf",
    size: 20,
    createdAt: 1,
  },
];

function fakeStorage(files: StoredFileListItem[] = FILES) {
  return {
    list: vi.fn(async () => [...files].reverse()),
    delete: vi.fn(async (name: string) =>
      files.some((file) => file.fileName === name),
    ),
  };
}

function makeRuntime(storage: unknown): IAgentRuntime {
  return {
    agentId: AGENT,
    getService: (type: string) => (type === REMOTE_FILES ? storage : null),
  } as unknown as IAgentRuntime;
}

function routeCtx(
  runtime: IAgentRuntime,
  accessContext?: AccessContext,
): RouteHandlerContext {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    method: "GET",
    path: "/api/files",
    runtime,
    inProcess: false,
    accessContext,
  };
}

describe("filesRoutes", () => {
  it("lists owner-visible files newest-first through the route handler", async () => {
    const result = await filesListRoute.routeHandler?.(
      routeCtx(makeRuntime(fakeStorage()), {
        requesterEntityId: VIEWER,
        role: "OWNER",
        isOwner: true,
      }),
    );

    expect(result?.status).toBe(200);
    expect(result?.body).toEqual({ files: FILES, restricted: false });
  });

  it("returns the restricted state for USER callers instead of raw store rows", async () => {
    const result = await filesListRoute.routeHandler?.(
      routeCtx(makeRuntime(fakeStorage()), {
        requesterEntityId: VIEWER,
        role: "USER",
      }),
    );

    expect(result?.status).toBe(200);
    expect(result?.body).toEqual({ files: [], restricted: true });
  });

  it("reports unavailable when the storage service is absent", async () => {
    const result = await filesListRoute.routeHandler?.(
      routeCtx(makeRuntime(null)),
    );
    expect(result).toEqual({
      status: 503,
      body: { error: "file storage unavailable" },
    });
  });

  it("deletes by route param through the storage service", async () => {
    const storage = fakeStorage();
    const result = await fileDeleteRoute.routeHandler?.({
      ...routeCtx(makeRuntime(storage)),
      method: "DELETE",
      path: "/api/files/new.png",
      params: { filename: "new.png" },
    });

    expect(result).toEqual({ status: 200, body: { deleted: true } });
    expect(storage.delete).toHaveBeenCalledWith("new.png");
  });
});
