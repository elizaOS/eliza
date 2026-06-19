import type http from "node:http";
import {
  PromoteVfsToCloudContainerRequestSchema,
  RequestCodingAgentContainerRequestSchema,
  SyncCloudCodingContainerRequestSchema,
} from "@elizaos/shared";
import type {
  PromoteVfsToCloudContainerRequest,
  PromoteVfsToCloudContainerResponse,
  RequestCodingAgentContainerRequest,
  RequestCodingAgentContainerResponse,
  SyncCloudCodingContainerRequest,
  SyncCloudCodingContainerResponse,
} from "../types/cloud";
import { sendJson, sendJsonError } from "../lib/http";

export interface CloudCodingContainerRouteState {
  runtime: {
    getService?: (name: string) => unknown;
  } | null;
}

interface CodingContainerServiceLike {
  promoteVfsToCloudContainer(
    request: PromoteVfsToCloudContainerRequest,
  ): Promise<PromoteVfsToCloudContainerResponse>;
  requestCodingAgentContainer(
    request: RequestCodingAgentContainerRequest,
  ): Promise<RequestCodingAgentContainerResponse>;
  syncCodingContainerChanges(
    containerId: string,
    request: SyncCloudCodingContainerRequest,
  ): Promise<SyncCloudCodingContainerResponse>;
}

export async function handleCloudCodingContainerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudCodingContainerRouteState,
): Promise<boolean> {
  if (
    method === "POST" &&
    pathname === "/api/cloud/coding-containers/promotions"
  ) {
    const service = getCloudContainerService(state);
    if (!service) {
      sendJsonError(res, "Cloud container service is not available", 503);
      return true;
    }
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const parsed = PromoteVfsToCloudContainerRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJsonError(
        res,
        parsed.error.issues[0]?.message ?? "Invalid promotion request",
        400,
      );
      return true;
    }
    await sendServiceResponse(res, () =>
      service.promoteVfsToCloudContainer(
        parsed.data as PromoteVfsToCloudContainerRequest,
      ),
    );
    return true;
  }

  if (method === "POST" && pathname === "/api/cloud/coding-containers") {
    const service = getCloudContainerService(state);
    if (!service) {
      sendJsonError(res, "Cloud container service is not available", 503);
      return true;
    }
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const parsed = RequestCodingAgentContainerRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJsonError(
        res,
        parsed.error.issues[0]?.message ?? "Invalid coding container request",
        400,
      );
      return true;
    }
    await sendServiceResponse(res, () =>
      service.requestCodingAgentContainer(
        parsed.data as RequestCodingAgentContainerRequest,
      ),
    );
    return true;
  }

  const syncMatch = /^\/api\/cloud\/coding-containers\/([^/]+)\/sync$/.exec(
    pathname,
  );
  if (method === "POST" && syncMatch) {
    const service = getCloudContainerService(state);
    if (!service) {
      sendJsonError(res, "Cloud container service is not available", 503);
      return true;
    }
    const containerId = decodeURIComponent(syncMatch[1]);
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const parsed = SyncCloudCodingContainerRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJsonError(
        res,
        parsed.error.issues[0]?.message ?? "Invalid sync request",
        400,
      );
      return true;
    }
    await sendServiceResponse(res, () =>
      service.syncCodingContainerChanges(
        containerId,
        parsed.data as SyncCloudCodingContainerRequest,
      ),
    );
    return true;
  }

  return false;
}

function getCloudContainerService(
  state: CloudCodingContainerRouteState,
): CodingContainerServiceLike | null {
  const service =
    state.runtime?.getService?.("CLOUD_CONTAINER") ??
    state.runtime?.getService?.("cloud-container") ??
    state.runtime?.getService?.("cloudContainer");
  if (!service || typeof service !== "object") return null;
  const candidate = service as Partial<CodingContainerServiceLike>;
  if (
    typeof candidate.promoteVfsToCloudContainer === "function" &&
    typeof candidate.requestCodingAgentContainer === "function" &&
    typeof candidate.syncCodingContainerChanges === "function"
  ) {
    return candidate as CodingContainerServiceLike;
  }
  return null;
}

async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  const preParsed = (req as http.IncomingMessage & { body?: unknown }).body;
  if (
    preParsed &&
    typeof preParsed === "object" &&
    !Array.isArray(preParsed)
  ) {
    return preParsed as Record<string, unknown>;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    sendJsonError(res, "Invalid JSON body", 400);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJsonError(res, "Invalid JSON body", 400);
    return null;
  }
  return parsed as Record<string, unknown>;
}

async function sendServiceResponse(
  res: http.ServerResponse,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    sendJson(res, await fn());
  } catch (error) {
    const status =
      typeof (error as { statusCode?: unknown })?.statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    sendJsonError(
      res,
      error instanceof Error ? error.message : String(error),
      status,
    );
  }
}
