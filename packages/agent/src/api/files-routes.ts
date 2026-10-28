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

// Default page for GET /api/files. The store scan itself is
// unbounded (every stored file is stat'ed per list call), so the
// route must not serialize the whole store by default: the Files
// surface is a recency-ordered browser, and single files stay
// addressable by name via GET /api/media/:fileName.
const FILES_LIST_DEFAULT_LIMIT = 200;
const FILES_LIST_MAX_LIMIT = 1000;

function queryNumber(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
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
    const limitRaw = queryNumber(ctx.query?.limit);
    const limit =
      limitRaw === null || limitRaw <= 0
        ? FILES_LIST_DEFAULT_LIMIT
        : Math.min(Math.floor(limitRaw), FILES_LIST_MAX_LIMIT);
    const offsetRaw = queryNumber(ctx.query?.offset);
    const offset =
      offsetRaw === null || offsetRaw < 0 ? 0 : Math.floor(offsetRaw);
    return {
      status: 200,
      body: { ...body, files: body.files.slice(offset, offset + limit) },
    };
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
