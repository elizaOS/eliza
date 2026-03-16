import { describe, test, expect, vi } from "vitest";
import {
  createMockIncomingMessage,
  createMockHttpResponse,
} from "../../src/test-support/test-helpers";
import { handlePermissionRoutes } from "../../src/api/permissions-routes";
import type { PermissionRouteContext } from "../../src/api/permissions-routes";

function buildCtx(
  method: string,
  pathname: string,
  overrides?: Partial<PermissionRouteContext>,
): PermissionRouteContext {
  const { res } = createMockHttpResponse();
  return {
    req: createMockIncomingMessage({ method, url: pathname }),
    res,
    method,
    pathname,
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, msg, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: msg }));
    }),
    readJsonBody: vi.fn(async () => ({})),
    state: {
      runtime: null,
      config: { features: { shellEnabled: false } },
      permissionStates: {},
      shellEnabled: false,
    },
    saveConfig: vi.fn(),
    scheduleRuntimeRestart: vi.fn(),
    ...overrides,
  } as PermissionRouteContext;
}

describe("permissions-routes", () => {
  describe("GET /api/permissions", () => {
    test("returns permission states with platform", async () => {
      const ctx = buildCtx("GET", "/api/permissions");
      const handled = await handlePermissionRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload).toHaveProperty("_platform");
      expect(payload).toHaveProperty("_shellEnabled");
    });
  });

  describe("GET /api/permissions/shell", () => {
    test("returns shell permission state", async () => {
      const ctx = buildCtx("GET", "/api/permissions/shell");
      const handled = await handlePermissionRoutes(ctx);
      expect(handled).toBe(true);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload).toHaveProperty("enabled");
      expect(payload).toHaveProperty("permission");
    });
  });

  describe("GET /api/permissions/:id", () => {
    test("returns not-applicable for unknown permission", async () => {
      const ctx = buildCtx("GET", "/api/permissions/camera");
      const handled = await handlePermissionRoutes(ctx);
      expect(handled).toBe(true);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.status).toBe("not-applicable");
    });

    test("returns stored state for known permission", async () => {
      const ctx = buildCtx("GET", "/api/permissions/camera", {
        state: {
          runtime: null,
          config: {},
          permissionStates: {
            camera: {
              id: "camera",
              status: "granted",
              lastChecked: Date.now(),
              canRequest: false,
            },
          },
        },
      });
      const handled = await handlePermissionRoutes(ctx);
      expect(handled).toBe(true);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.status).toBe("granted");
    });
  });

  describe("PUT /api/permissions/shell", () => {
    test("enables shell and saves config", async () => {
      const ctx = buildCtx("PUT", "/api/permissions/shell", {
        readJsonBody: vi.fn(async () => ({ enabled: true })),
      });
      await handlePermissionRoutes(ctx);
      expect(ctx.saveConfig).toHaveBeenCalled();
      expect(ctx.state.shellEnabled).toBe(true);
    });

    test("schedules restart when runtime exists", async () => {
      const ctx = buildCtx("PUT", "/api/permissions/shell", {
        readJsonBody: vi.fn(async () => ({ enabled: true })),
        state: {
          runtime: {} as any,
          config: { features: {} },
          shellEnabled: false,
        },
      });
      await handlePermissionRoutes(ctx);
      expect(ctx.scheduleRuntimeRestart).toHaveBeenCalled();
    });

    test("does not schedule restart when no runtime", async () => {
      const ctx = buildCtx("PUT", "/api/permissions/shell", {
        readJsonBody: vi.fn(async () => ({ enabled: true })),
      });
      await handlePermissionRoutes(ctx);
      expect(ctx.scheduleRuntimeRestart).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/permissions/refresh", () => {
    test("returns refresh message", async () => {
      const ctx = buildCtx("POST", "/api/permissions/refresh");
      const handled = await handlePermissionRoutes(ctx);
      expect(handled).toBe(true);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.action).toBe("ipc:permissions:refresh");
    });
  });

  describe("POST /api/permissions/:id/request", () => {
    test("returns request action", async () => {
      const ctx = buildCtx("POST", "/api/permissions/camera/request");
      const handled = await handlePermissionRoutes(ctx);
      expect(handled).toBe(true);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.action).toBe("ipc:permissions:request:camera");
    });
  });

  describe("POST /api/permissions/:id/open-settings", () => {
    test("returns open-settings action", async () => {
      const ctx = buildCtx("POST", "/api/permissions/microphone/open-settings");
      const handled = await handlePermissionRoutes(ctx);
      expect(handled).toBe(true);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.action).toBe("ipc:permissions:openSettings:microphone");
    });
  });

  describe("PUT /api/permissions/state", () => {
    test("updates permission states", async () => {
      const ctx = buildCtx("PUT", "/api/permissions/state", {
        readJsonBody: vi.fn(async () => ({
          permissions: {
            camera: {
              id: "camera",
              status: "granted",
              lastChecked: Date.now(),
              canRequest: false,
            },
          },
        })),
      });
      const handled = await handlePermissionRoutes(ctx);
      expect(handled).toBe(true);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.updated).toBe(true);
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handlePermissionRoutes(ctx)).toBe(false);
    });
  });
});
