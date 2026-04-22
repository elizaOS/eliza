import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "../lifeops/service.js";
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
  readJsonBody: ReturnType<typeof vi.fn>;
} {
  const url = new URL(path, "http://localhost");
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn(async () => ({}));
  const context: LifeOpsRouteContext = {
    req: {
      url: `${url.pathname}${url.search}`,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
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
    readJsonBody,
    decodePathComponent: (raw) => decodeURIComponent(raw),
    ...overrides,
  };

  return {
    context,
    error,
    json,
    readJsonBody: context.readJsonBody as ReturnType<typeof vi.fn>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("rejects non-string iMessage recipients at the route boundary", async () => {
    const readJsonBody = vi.fn(async () => ({ to: 1, text: "hi" }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/connectors/imessage/send",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(context.res, "to is required", 400);
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects non-string iMessage attachment paths", async () => {
    const readJsonBody = vi.fn(async () => ({
      to: "+15551112222",
      text: "hi",
      attachmentPaths: ["/tmp/a.txt", 1],
    }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/connectors/imessage/send",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "attachmentPaths must be an array of strings",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects string booleans for X DM curation", async () => {
    const readJsonBody = vi.fn(async () => ({
      messageIds: ["dm-1"],
      markRead: "false",
    }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/x/dms/curate",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "markRead must be a boolean",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects scalar messageIds for X DM curation", async () => {
    const readJsonBody = vi.fn(async () => ({ messageIds: "abc" }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/x/dms/curate",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "messageIds must be an array of strings",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects X DM digest limits above the route maximum before service dispatch", async () => {
    const getXDmDigest = vi.spyOn(
      LifeOpsService.prototype,
      "getXDmDigest",
    );
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/x/dms/digest?limit=101",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "limit must be less than or equal to 100",
      400,
    );
    expect(json).not.toHaveBeenCalled();
    expect(getXDmDigest).not.toHaveBeenCalled();
  });

  // Browser companion + package routes moved to
  // `@elizaos/plugin-browser-bridge` (Phase 3). Tests for those routes now
  // live alongside the plugin package.
});
