/**
 * Covers `handlePermissionRoutes` — the `/api/permissions/*` read, request,
 * and open-settings surface — over a fake runtime whose permissions registry
 * is a mocked `IPermissionsRegistry`. Deterministic and in-memory: asserts
 * canonical-id resolution from persisted state, registry delegation with
 * feature metadata, the unavailable-permission fallback when the registry has
 * no prober for a permission (#12660), and rejection of unknown permission ids.
 */
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
    openSettings: overrides.openSettings ?? vi.fn(async () => false),
  };
}

function makeContext(
  pathname: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
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
    readJsonBody: async <T extends object>() =>
      options.body ? (options.body as T) : null,
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

  it("reads website-blocking through the registry like any other permission", async () => {
    const websiteBlocking = permissionState("website-blocking", {
      status: "denied",
      canRequest: true,
      reason: "hosts file requires administrator approval",
    });
    const registry = makeRegistry(websiteBlocking);
    const ctx = makeContext("/api/permissions/website-blocking", {
      registry,
    });

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(registry.get).toHaveBeenCalledWith("website-blocking");
    expect(ctx.captured.data).toEqual(websiteBlocking);
  });

  it("requests website-blocking through the registry with feature metadata", async () => {
    const websiteBlocking = permissionState("website-blocking", {
      status: "granted",
      canRequest: false,
    });
    const registry = makeRegistry(websiteBlocking);
    const ctx = makeContext("/api/permissions/website-blocking/request", {
      method: "POST",
      registry,
    });

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(registry.request).toHaveBeenCalledWith("website-blocking", {
      reason: "Requested from permissions API.",
      feature: { app: "settings", action: "request.website-blocking" },
    });
    expect(ctx.captured.data).toEqual(websiteBlocking);
  });

  it("degrades to an unavailable state when no website-blocking prober is registered", async () => {
    // #12660 drift regression: with the central stub removed, website-blocking
    // has a prober only when @elizaos/plugin-personal-assistant is loaded.
    // Without it the registry throws "no prober registered for
    // website-blocking"; the route must catch and return the
    // unavailable-permission shape (not the old hardwired "granted").
    const websiteBlocking = permissionState("website-blocking");
    const registry = makeRegistry(websiteBlocking, {
      request: vi.fn(async () => {
        throw new Error(
          "[PermissionRegistry] no prober registered for website-blocking",
        );
      }),
    });
    const ctx = makeContext("/api/permissions/website-blocking/request", {
      method: "POST",
      registry,
    });

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(registry.request).toHaveBeenCalledWith("website-blocking", {
      reason: "Requested from permissions API.",
      feature: { app: "settings", action: "request.website-blocking" },
    });
    // Success response (no error status), carrying the unavailable shape.
    expect(ctx.captured.status).toBeUndefined();
    expect(ctx.captured.data).toMatchObject({
      id: "website-blocking",
      status: "not-applicable",
      canRequest: false,
      reason: "Native permission checks are unavailable in this runtime.",
    });
  });

  it("opens website-blocking settings through the registry hook", async () => {
    const websiteBlocking = permissionState("website-blocking", {
      status: "denied",
      canRequest: true,
    });
    const registry = makeRegistry(websiteBlocking, {
      openSettings: vi.fn(async () => true),
    });
    const ctx = makeContext("/api/permissions/website-blocking/open-settings", {
      method: "POST",
      registry,
      state: { permissionStates: { "website-blocking": websiteBlocking } },
    });

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(registry.openSettings).toHaveBeenCalledWith("website-blocking");
    expect(ctx.captured.data).toEqual({
      opened: true,
      id: "website-blocking",
      permission: websiteBlocking,
    });
  });

  it("rejects unknown permission ids", async () => {
    const ctx = makeContext("/api/permissions/unknown-permission");

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.status).toBe(400);
    expect(ctx.captured.data).toEqual({ error: "Invalid permission ID" });
  });

  it("accepts limited status without changing legacy granted payloads", async () => {
    const ctx = makeContext("/api/permissions/state", {
      method: "PUT",
      body: {
        permissions: {
          calendar: {
            id: "calendar",
            status: "limited",
            canRequest: true,
            lastChecked: 10,
            platform: "ios",
            reason: "Add-only access.",
          },
          contacts: {
            id: "contacts",
            status: "granted",
            canRequest: false,
            lastChecked: 9,
            platform: "ios",
          },
        },
      },
    });

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    expect(ctx.captured.status).toBeUndefined();
    expect(ctx.captured.data).toMatchObject({
      updated: true,
      permissions: {
        calendar: { status: "limited" },
        contacts: { status: "granted" },
      },
    });
  });

  it("projects native personal-data capabilities from persisted permission state", async () => {
    const ctx = makeContext("/api/permissions/native-projection", {
      state: {
        permissionStates: {
          contacts: permissionState("contacts", {
            status: "granted",
            canRequest: false,
          }),
          messages: permissionState("messages", {
            status: "denied",
            canRequest: true,
          }),
          health: permissionState("health", {
            status: "restricted",
            canRequest: false,
            restrictedReason: "platform_unsupported",
          }),
        },
      },
    });

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    const projection = ctx.captured.data as {
      residency: string;
      account: {
        mode: string;
        status: string;
        capabilities: Array<{ capabilityId: string; status: string }>;
      };
      domains: Array<{
        domain: string;
        availability: string;
        capabilities: Array<{ capabilityId: string; status: string }>;
      }>;
    };
    expect(projection.residency).toBe("device");
    expect(projection.account.mode).toBe("native");
    expect(projection.account.status).toBe("connected");
    expect(projection.domains).toHaveLength(8);

    const byDomain = new Map(projection.domains.map((d) => [d.domain, d]));
    expect(byDomain.get("contacts")?.availability).toBe("available");
    expect(byDomain.get("messages")?.availability).toBe("denied");
    expect(
      byDomain
        .get("messages")
        ?.capabilities.every((c) => c.status === "needs_scope"),
    ).toBe(true);
    expect(byDomain.get("health")?.availability).toBe("restricted");
    // Domains with no persisted state fall back to the unavailable stub and
    // must project as unsupported, never as a fabricated grant.
    expect(byDomain.get("location")?.availability).toBe("unsupported");

    // Metadata-only invariant: no personal payload fields ride along.
    const domainKeys = Object.keys(projection.domains[0]).sort();
    expect(domainKeys).toEqual(
      [
        "availability",
        "canRequest",
        "capabilities",
        "domain",
        "label",
        "lastCheckedAt",
        "permissionId",
        "permissionStatus",
        "platform",
        "residency",
        "restrictedReason",
        "worksOffline",
      ].sort(),
    );
  });

  it("projects every domain as unsupported when no registry or persisted state exists", async () => {
    const ctx = makeContext("/api/permissions/native-projection");

    await expect(handlePermissionRoutes(ctx)).resolves.toBe(true);

    const projection = ctx.captured.data as {
      account: { status: string };
      domains: Array<{ availability: string }>;
    };
    expect(projection.account.status).toBe("unavailable");
    expect(
      projection.domains.every((d) => d.availability === "unsupported"),
    ).toBe(true);
  });
});
