/**
 * Authenticated Files API over the content-addressed media store: list and
 * delete stored attachment bytes for the "Files" surface. Reads/writes go
 * through the {@link IFileStorageService} (ServiceType.REMOTE_FILES), never the
 * fs directly. Unlike the pre-auth media *serve* route (the sha256 is the
 * capability), these privileged operations are auth-gated (PrivateRoute).
 */

import {
  type IAgentRuntime,
  type IFileStorageService,
  type Route,
  ServiceType,
} from "@elizaos/core";

function getFileStorage(runtime: IAgentRuntime): IFileStorageService | null {
  return (
    runtime.getService<IFileStorageService>(ServiceType.REMOTE_FILES) ?? null
  );
}

/** GET /api/files — list every stored file (newest first). */
export const filesListRoute: Route = {
  type: "GET",
  path: "/api/files",
  rawPath: true,
  name: "files-list",
  routeHandler: async (ctx) => {
    const storage = getFileStorage(ctx.runtime);
    if (!storage) {
      return { status: 503, body: { error: "file storage unavailable" } };
    }
    const files = await storage.list();
    files.sort((a, b) => b.createdAt - a.createdAt);
    return { status: 200, body: { files } };
  },
};

/** DELETE /api/files/:filename — delete one stored file (reference-unaware). */
export const fileDeleteRoute: Route = {
  type: "DELETE",
  path: "/api/files/:filename",
  rawPath: true,
  name: "file-delete",
  routeHandler: async (ctx) => {
    const storage = getFileStorage(ctx.runtime);
    if (!storage) {
      return { status: 503, body: { error: "file storage unavailable" } };
    }
    const filename = ctx.params?.filename ?? "";
    const deleted = await storage.delete(filename);
    return {
      status: deleted ? 200 : 404,
      body: { deleted },
    };
  },
};

export const filesRoutes: Route[] = [filesListRoute, fileDeleteRoute];
