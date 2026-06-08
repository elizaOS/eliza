import type { Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { interact } from "./simple-views.interact.js";
import { simpleViewsSnapshot } from "./storage.js";

function stringBodyField(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function paramsBodyField(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = body.params;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function routeBody(req: RouteRequest): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function sendJson(
  res: RouteResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.status(status).json(body);
}

async function handleInteract(req: RouteRequest, res: RouteResponse): Promise<void> {
  const record = routeBody(req);
  const capability = stringBodyField(record, "capability");
  if (!capability) {
    sendJson(res, 400, { success: false, text: "Capability is required." });
    return;
  }

  try {
    const result = await interact(capability, paramsBodyField(record));
    sendJson(res, 200, {
      result,
      state: simpleViewsSnapshot(),
    });
  } catch (err) {
    sendJson(res, 400, {
      result: {
        success: false,
        text: err instanceof Error ? err.message : String(err),
      },
      state: simpleViewsSnapshot(),
    });
  }
}

export const simpleViewsRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/simple-views/state",
    rawPath: true,
    handler: async (_req, res) => {
      sendJson(res, 200, simpleViewsSnapshot());
    },
  },
  {
    type: "POST",
    path: "/api/simple-views/interact",
    rawPath: true,
    handler: handleInteract,
  },
];
