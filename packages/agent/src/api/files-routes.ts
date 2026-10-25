/**
 * Authenticated Files API over the content-addressed media store: list and
 * delete stored attachment bytes for the "Files" surface. Reads/writes go
 * through the {@link IFileStorageService} (ServiceType.REMOTE_FILES), never the
 * fs directly. Unlike the pre-auth media *serve* route (the sha256 is the
 * capability), these privileged operations are auth-gated (PrivateRoute).
 */
import {
  actorFromAccessContext,
  type IAgentRuntime,
  type IFileStorageService,
  isAdminRank,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import type { Route } from "@elizaos/host/protocol";

import { selectFilesForViewer } from "./files-disclosure.ts";

function getFileStorage(runtime: IAgentRuntime): IFileStorageService | null {
  return (
    runtime.getService<IFileStorageService>(ServiceType.REMOTE_FILES) ?? null
  );
}
/**
 * GET /api/files — list stored files (newest first), selected per viewer
 * (#14778): the single-owner boundary and OWNER/ADMIN-rank viewers see the
 * whole store; USER/GUEST viewers get the designed restricted state.
 */
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
    files.sort((a, b) => {
      const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
      const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
      return bTime - aTime;
    });
    const body = selectFilesForViewer(
      files,
      ctx.accessContext,
      ctx.runtime.agentId as UUID,
    );
    return { status: 200, body };
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
    // The raw store is an owner/admin management surface, as the list
    // route enforces: USER/GUEST viewers get the restricted state there,
    // so they must not delete here either. No context means the
    // single-owner boundary, which keeps current behavior.
    if (ctx.accessContext) {
      const actor = actorFromAccessContext(
        ctx.accessContext,
        ctx.runtime.agentId as UUID,
      );
      if (!isAdminRank(actor.role) && actor.role !== "AGENT") {
        return { status: 403, body: { error: "file deletion is restricted" } };
      }
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
