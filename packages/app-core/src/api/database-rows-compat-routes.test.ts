import http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleDatabaseRowsCompatRoute } from "./database-rows-compat-routes";

const sharedMocks = vi.hoisted(() => ({
  executeRawSql: vi.fn(),
}));

vi.mock("@elizaos/shared", async () => {
  return {
    executeRawSql: sharedMocks.executeRawSql,
    quoteIdent: (value: string) => `"${value.replaceAll('"', '""')}"`,
    sanitizeIdentifier: (value: string | null | undefined) =>
      value?.replace(/[^a-zA-Z0-9_]/g, "") || null,
    sqlLiteral: (value: string) => `'${value.replaceAll("'", "''")}'`,
  };
});

function makeReq(url: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = url;
  req.headers = { host: "localhost:3000" };
  return req;
}

function fakeRes() {
  let body = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    json: () => (body ? JSON.parse(body) : null),
  };
}

function makeState(
  current: CompatRuntimeState["current"] = null,
): CompatRuntimeState {
  return {
    current,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

describe("handleDatabaseRowsCompatRoute", () => {
  it("requires OWNER role before raw table rows can be read", async () => {
    const req = makeReq("/api/database/tables/secrets/rows");
    const res = fakeRes();
    const ensureOwner = vi.fn(async (_req, routeRes) => {
      routeRes.statusCode = 403;
      routeRes.end(JSON.stringify({ error: "Insufficient role" }));
      return false;
    });

    await expect(
      handleDatabaseRowsCompatRoute(req, res.res, makeState(), { ensureOwner }),
    ).resolves.toBe(true);

    expect(ensureOwner).toHaveBeenCalledWith(
      req,
      res.res,
      expect.anything(),
      "OWNER",
    );
    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({ error: "Insufficient role" });
    expect(sharedMocks.executeRawSql).not.toHaveBeenCalled();
  });

  it("continues route handling after OWNER authorization succeeds", async () => {
    const req = makeReq("/api/database/tables/memories/rows");
    const res = fakeRes();
    const ensureOwner = vi.fn(async () => true);

    await expect(
      handleDatabaseRowsCompatRoute(req, res.res, makeState(), { ensureOwner }),
    ).resolves.toBe(true);

    expect(ensureOwner).toHaveBeenCalledWith(
      req,
      res.res,
      expect.anything(),
      "OWNER",
    );
    expect(res.status()).toBe(503);
    expect(res.json()).toEqual({
      error:
        "Database not available. The agent may not be running or the database adapter is not initialized.",
    });
  });
});
