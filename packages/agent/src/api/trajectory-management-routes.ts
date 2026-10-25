/**
 * Owner-side trajectory management routes for the Trajectories view:
 * GET | PUT /api/trajectories/config, POST /api/trajectories/export and
 * DELETE /api/trajectories. The caller enforces the owner gate that covers
 * every /api/trajectories path before dispatching here. Reads stay with
 * `tryHandleTrajectoryReadRoutes`; both resolve the same "trajectories" service.
 */

import type http from "node:http";
import {
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  type IAgentRuntime,
  type TrajectoryExportOptions,
  type TrajectoryExportResult,
} from "@elizaos/core";
import { readJsonBody, sendJson, sendJsonError } from "@elizaos/host";
import z from "zod";
import { createZipArchive } from "./zip-utils.ts";

const TRAJECTORY_MANAGEMENT_MAX_BODY_BYTES = 1024 * 1024;

const TrajectoryStatusSchema = z.enum([
  "active",
  "completed",
  "error",
  "timeout",
  "terminated",
]);

const PutTrajectoryConfigRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();

const PostTrajectoryExportRequestSchema = z
  .object({
    format: z.enum(["json", "jsonl", "csv", "art", "zip"]),
    jsonShape: z.literal(ELIZA_NATIVE_TRAJECTORY_FORMAT).optional(),
    includePrompts: z.boolean().optional(),
    trajectoryIds: z.array(z.string().min(1)).optional(),
    source: z.string().optional(),
    status: TrajectoryStatusSchema.optional(),
    runId: z.string().optional(),
    search: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    scenarioId: z.string().optional(),
    traceId: z.string().optional(),
    batchId: z.string().optional(),
  })
  .strict();

const DeleteTrajectoriesRequestSchema = z.union([
  z.object({ clearAll: z.literal(true) }).strict(),
  z.object({ trajectoryIds: z.array(z.string().min(1)).min(1) }).strict(),
]);

interface TrajectoryManagementService {
  isEnabled?: () => boolean;
  setEnabled?: (enabled: boolean) => void;
  deleteTrajectories?: (trajectoryIds: string[]) => Promise<number>;
  clearAllTrajectories?: () => Promise<number>;
  exportTrajectories?: (
    options: TrajectoryExportOptions,
  ) => Promise<TrajectoryExportResult>;
  exportTrajectoriesZip?: (
    options: Omit<TrajectoryExportOptions, "format" | "jsonShape">,
  ) => Promise<{
    filename: string;
    entries: { name: string; data: string }[];
  }>;
}

type TrajectoryManagementOperation = keyof TrajectoryManagementService;

function sendAttachment(
  res: http.ServerResponse,
  filename: string,
  mimeType: string,
  data: string | Uint8Array,
): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.end(data);
}

async function readValidatedBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const raw = await readJsonBody<Record<string, unknown>>(req, res, {
    maxBytes: TRAJECTORY_MANAGEMENT_MAX_BODY_BYTES,
  });
  if (raw === null) return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    sendJsonError(
      res,
      parsed.error.issues[0]?.message ?? "Invalid request body",
      400,
    );
    return null;
  }
  return parsed.data;
}

/**
 * Returns `true` when the request was answered, `false` when the path/method is
 * not a trajectory management route. Service failures propagate to the caller.
 */
export async function handleTrajectoryManagementRoutes(options: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  runtime: IAgentRuntime | null | undefined;
}): Promise<boolean> {
  const { req, res, method, pathname, runtime } = options;
  const isConfig = pathname === "/api/trajectories/config";
  const route =
    isConfig && method === "GET"
      ? "getConfig"
      : isConfig && method === "PUT"
        ? "putConfig"
        : pathname === "/api/trajectories/export" && method === "POST"
          ? "export"
          : pathname === "/api/trajectories" && method === "DELETE"
            ? "delete"
            : null;
  if (!route) return false;

  const service = runtime?.getService?.("trajectories") as
    | TrajectoryManagementService
    | null
    | undefined;
  if (!service) {
    sendJsonError(res, "Trajectory service unavailable", 503);
    return true;
  }
  const unsupported = (operation: TrajectoryManagementOperation): true => {
    sendJsonError(res, `Trajectory service does not support ${operation}`, 503);
    return true;
  };

  if (route === "getConfig") {
    if (!service.isEnabled) return unsupported("isEnabled");
    sendJson(res, { enabled: service.isEnabled() });
    return true;
  }

  if (route === "putConfig") {
    if (!service.isEnabled) return unsupported("isEnabled");
    if (!service.setEnabled) return unsupported("setEnabled");
    const body = await readValidatedBody(
      req,
      res,
      PutTrajectoryConfigRequestSchema,
    );
    if (!body) return true;
    service.setEnabled(body.enabled);
    sendJson(res, { enabled: service.isEnabled() });
    return true;
  }

  if (route === "delete") {
    if (!service.deleteTrajectories) return unsupported("deleteTrajectories");
    if (!service.clearAllTrajectories)
      return unsupported("clearAllTrajectories");
    const body = await readValidatedBody(
      req,
      res,
      DeleteTrajectoriesRequestSchema,
    );
    if (!body) return true;
    const deleted =
      "clearAll" in body
        ? await service.clearAllTrajectories()
        : await service.deleteTrajectories(body.trajectoryIds);
    sendJson(res, { deleted });
    return true;
  }

  const body = await readValidatedBody(
    req,
    res,
    PostTrajectoryExportRequestSchema,
  );
  if (!body) return true;
  const { format, jsonShape, ...filters } = body;
  if (jsonShape && format !== "json" && format !== "jsonl") {
    sendJsonError(res, "jsonShape applies only to json and jsonl exports", 400);
    return true;
  }
  if (format === "zip") {
    if (!service.exportTrajectoriesZip)
      return unsupported("exportTrajectoriesZip");
    const archive = await service.exportTrajectoriesZip(filters);
    sendAttachment(
      res,
      archive.filename,
      "application/zip",
      createZipArchive(archive.entries),
    );
    return true;
  }
  if (!service.exportTrajectories) return unsupported("exportTrajectories");
  const result = await service.exportTrajectories({
    ...filters,
    format,
    ...(jsonShape ? { jsonShape } : {}),
  });
  sendAttachment(res, result.filename, result.mimeType, result.data);
  return true;
}
