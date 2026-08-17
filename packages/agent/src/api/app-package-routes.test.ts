/**
 * Exercises the production dynamic app-package dispatcher with mocked package
 * loading so URL-boundary failures and valid handler delegation remain
 * deterministic and side-effect free.
 */
import type http from "node:http";
import type { AppPackageRouteDispatchContext } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { importAppRouteModuleMock } = vi.hoisted(() => ({
  importAppRouteModuleMock: vi.fn(),
}));

vi.mock("../services/app-package-modules.ts", () => ({
  importAppRouteModule: importAppRouteModuleMock,
}));

// Keep this focused dispatcher test independent of the broad server-helper
// module graph while preserving the decoder's real response contract.
vi.mock("./server-helpers.ts", () => ({
  decodePathComponent(
    raw: string,
    res: http.ServerResponse,
    fieldName: string,
  ): string | null {
    try {
      return decodeURIComponent(raw);
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: `Invalid ${fieldName}: malformed URL encoding`,
        }),
      );
      return null;
    }
  },
}));

import { handleAppPackageRoutes } from "./app-package-routes.ts";

function createContext(pathname: string): {
  context: AppPackageRouteDispatchContext;
  error: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  readJsonBody: ReturnType<typeof vi.fn>;
  req: http.IncomingMessage;
  res: http.ServerResponse;
} {
  const req = {} as http.IncomingMessage;
  const end = vi.fn();
  const res = {
    setHeader: vi.fn(),
    end,
  } as unknown as http.ServerResponse;
  const error = vi.fn();
  const readJsonBody = vi.fn(async () => ({ ok: true }));
  const context = {
    req,
    res,
    method: "GET",
    pathname,
    url: new URL("http://localhost/"),
    runtime: null,
    json: vi.fn(),
    error,
    readJsonBody,
  } as unknown as AppPackageRouteDispatchContext;

  return { context, error, end, readJsonBody, req, res };
}

describe("dynamic app-package route dispatch", () => {
  beforeEach(() => {
    importAppRouteModuleMock.mockReset();
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "handles malformed app slug encoding %s as a 400",
    async (encodedSlug) => {
      const { context, end, error, res } = createContext(
        `/api/apps/${encodedSlug}/run`,
      );

      await expect(handleAppPackageRoutes(context)).resolves.toBe(true);

      expect(res.statusCode).toBe(400);
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/json",
      );
      expect(end).toHaveBeenCalledWith(
        JSON.stringify({
          error: "Invalid app slug: malformed URL encoding",
        }),
      );
      expect(error).not.toHaveBeenCalled();
      expect(importAppRouteModuleMock).not.toHaveBeenCalled();
    },
  );

  it.each(["/api/commands", "/api/apps/info", "/api/apps/%69nfo"])(
    "leaves unmatched or reserved route %s for the next dispatcher",
    async (pathname) => {
      const { context, error } = createContext(pathname);

      await expect(handleAppPackageRoutes(context)).resolves.toBe(false);

      expect(error).not.toHaveBeenCalled();
      expect(importAppRouteModuleMock).not.toHaveBeenCalled();
    },
  );

  it("dispatches a valid encoded slug with a request-bound body reader", async () => {
    const { context, error, readJsonBody, req, res } = createContext(
      "/api/apps/example%2Dapp/run",
    );
    const routeHandler = vi.fn(async (appContext) => {
      await appContext.readJsonBody({ maxBytes: 1_024 });
      return true;
    });
    importAppRouteModuleMock.mockResolvedValue({
      handleAppRoutes: routeHandler,
    });

    await expect(handleAppPackageRoutes(context)).resolves.toBe(true);

    expect(importAppRouteModuleMock).toHaveBeenCalledWith("example-app");
    expect(routeHandler).toHaveBeenCalledOnce();
    expect(readJsonBody).toHaveBeenCalledWith(req, res, { maxBytes: 1_024 });
    expect(error).not.toHaveBeenCalled();
  });
});
