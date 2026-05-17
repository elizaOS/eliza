import type { AgentRuntime } from "@elizaos/core";
import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionState,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS_REGISTRY_SERVICE } from "../services/permissions-registry.ts";
import {
  handlePermissionRoutes,
  type PermissionRouteContext,
  type PermissionRouteState,
} from "./permissions-routes.ts";

function permissionState(
  id: PermissionId,
  overrides: Partial<PermissionState> = {},
): PermissionState {
  return {
    id,
    status: "not-determined",
    canRequest: true,
    lastChecked: 1,
    platform: "darwin",
    ...overrides,
  };
}

function makeRegistry(
  state: PermissionState,
  overrides: Partial<IPermissionsRegistry> = {},
): IPermissionsRegistry {
  return {
    get: vi.fn(() => state),
    check: vi.fn(async () => state),
    request: vi.fn(async () => state),
    recordBlock: vi.fn(),
    list: vi.fn(() => [state]),
    pending: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    registerProber: vi.fn(),
    ...overrides,
  };
}

function makeContext(
  pathname: string,
  options: {
    method?: string;
    state?: Partial<PermissionRouteState>;
    registry?: IPermissionsRegistry | null;
  } = {},
): PermissionRouteContext & { captured: { data?: unknown; status?: number } } {
  const captured: { data?: unknown; status?: number } = {};
  const runtime = {
    getService: (serviceType: string) =>
      serviceType === PERMISSIONS_REGISTRY_SERVICE
        ? (options.registry ?? null)
        : null,
  } as unknown as AgentRuntime;
  const state: PermissionRouteState = {
    runtime,
    config: {},
    ...options.state,
  };

  return {
    req: {} as PermissionRouteContext["req"],
    res: {} as PermissionRouteContext["res"],
    method: options.method ?? "GET",
    pathname,
    state,
    saveConfig: vi.fn(),
    scheduleRuntimeRestart: vi.fn(),
    readJsonBody: vi.fn(async () => null),
    json: vi.fn((_res, data, status) => {
      captured.data = data;
      captured.status = status;
    }),
    error: vi.fn((_res, message, status) => {
      captured.data = { error: message };
      captured.status = status;
    }),
    captured,
  };
}

describe("permission routes", () => {
  it("returns canonical non-legacy permission ids from persisted state", async () => {
    const health = permissionState("health", {
      status: "restricted",
      canRequest: false,
      restrictedReason: "entitlement_required",
    });
    const ctx = makeContext("/api/permissions/health", {
      state: { permissionStates: { health } },
    });

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.data).toEqual(health);
  });

  it("requests canonical permissions through the registry with feature metadata", async () => {
    const reminders = permissionState("reminders", {
      status: "granted",
      canRequest: false,
    });
    const registry = makeRegistry(reminders);
    const ctx = makeContext("/api/permissions/reminders/request", {
      method: "POST",
      registry,
    });

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(registry.request).toHaveBeenCalledWith("reminders", {
      reason: "Requested from permissions API.",
      feature: { app: "settings", action: "request.reminders" },
    });
    expect(ctx.captured.data).toEqual(reminders);
  });

  it("rejects unknown permission ids", async () => {
    const ctx = makeContext("/api/permissions/unknown-permission");

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.status).toBe(400);
    expect(ctx.captured.data).toEqual({ error: "Invalid permission ID" });
  });
});
