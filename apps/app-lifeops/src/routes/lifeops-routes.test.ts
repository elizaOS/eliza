import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleLifeOpsRoutes, type LifeOpsRouteContext } from "./lifeops-routes.js";

const runtime = {
  agentId: "00000000-0000-0000-0000-000000000000",
} as LifeOpsRouteContext["state"]["runtime"];

function createContext(
  method: string,
  path: string,
  overrides: Partial<LifeOpsRouteContext> = {},
): {
  context: LifeOpsRouteContext;
  error: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const url = new URL(path, "http://localhost");
  const json = vi.fn();
  const error = vi.fn();
  const context: LifeOpsRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname: url.pathname,
    url,
    state: {
      runtime,
      adminEntityId: null,
    },
    json,
    error,
    readJsonBody: vi.fn(async () => ({})),
    decodePathComponent: (raw) => decodeURIComponent(raw),
    ...overrides,
  };

  return { context, error, json };
}

describe("LifeOps route validation", () => {
  it("rejects malformed positive integer query values", async () => {
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/x/dms/digest?limit=10abc",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "limit must be a positive integer",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects mismatched connector side values before dispatch", async () => {
    const readJsonBody = vi.fn(async () => ({ side: "agent" }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/connectors/signal/pair?side=owner",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "side must match between query string and request body",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("returns a 400 for missing Signal pairing session id", async () => {
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/connectors/signal/pairing-status",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(context.res, "sessionId is required", 400);
    expect(json).not.toHaveBeenCalled();
  });
});
