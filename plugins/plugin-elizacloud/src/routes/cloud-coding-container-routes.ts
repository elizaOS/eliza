import type http from "node:http";
import {
  CLOUD_CONTAINER_SERVICE_TYPE,
  PromoteVfsToCloudContainerRequestSchema,
  RequestCodingAgentContainerRequestSchema,
  SyncCloudCodingContainerRequestSchema,
} from "@elizaos/shared";
import type {
  CloudCodingContainerService,
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

function decodeContainerId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
		// error-policy:J3 Malformed percent-encoding is invalid path input, not a cloud
		// container outage.
    return null;
  }
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
    const rawId = syncMatch[1];
    if (rawId === undefined) {
      sendJsonError(res, "Missing container id", 400);
      return true;
    }
    const containerId = decodeContainerId(rawId);
    if (containerId === null) {
      sendJsonError(
        res,
        "Invalid container id: malformed URL encoding",
        400,
      );
      return true;
    }
    const service = getCloudContainerService(state);
    if (!service) {
      sendJsonError(res, "Cloud container service is not available", 503);
      return true;
    }
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
): CloudCodingContainerService | null {
  const service = state.runtime?.getService?.(CLOUD_CONTAINER_SERVICE_TYPE);
  if (!service || typeof service !== "object") return null;
  const candidate = service as Partial<CloudCodingContainerService>;
  if (
    typeof candidate.promoteVfsToCloudContainer === "function" &&
    typeof candidate.requestCodingAgentContainer === "function" &&
    typeof candidate.syncCodingContainerChanges === "function"
  ) {
    return candidate as CloudCodingContainerService;
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
    // error-policy:J3 sanitizing boundary — an unparseable request body is an
    // explicit 400 the caller maps to invalid input; null signals "already
    // responded" to the handler.
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
    // error-policy:J1 boundary translation — a typed error's carried statusCode
    // is honoured, otherwise the failure surfaces as a 500; the route never
    // fabricates a success payload on error.
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
