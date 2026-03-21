import type { AgentRuntime } from "@elizaos/core";
import type { RouteRequestContext } from "./route-helpers";

interface AutonomousConfigLike {
  features?: {
    shellEnabled?: boolean;
  };
  plugins?: {
    entries?: Record<string, { enabled?: boolean }>;
  };
}

interface PermissionState {
  id: string;
  status: string;
  lastChecked: number;
  canRequest: boolean;
}

export interface PermissionRouteState {
  runtime: AgentRuntime | null;
  config: AutonomousConfigLike;
  permissionStates?: Record<string, PermissionState>;
  shellEnabled?: boolean;
}

export interface PermissionRouteContext extends RouteRequestContext {
  state: PermissionRouteState;
  saveConfig: (config: AutonomousConfigLike) => void;
  scheduleRuntimeRestart: (reason: string) => void;
}

export async function handlePermissionRoutes(
  ctx: PermissionRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    state,
    readJsonBody,
    json,
    error,
    saveConfig,
    scheduleRuntimeRestart,
  } = ctx;

  if (!pathname.startsWith("/api/permissions")) return false;

  if (method === "GET" && pathname === "/api/permissions") {
    const permStates = state.permissionStates ?? {};
    json(res, {
      ...permStates,
      _platform: process.platform,
      _shellEnabled: state.shellEnabled ?? true,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/permissions/shell") {
    const enabled = state.shellEnabled ?? true;
    if (!state.permissionStates) {
      state.permissionStates = {};
    }
    const shellState = state.permissionStates.shell;
    const permission: PermissionState = {
      id: "shell",
      status: enabled ? "granted" : "denied",
      lastChecked: shellState?.lastChecked ?? Date.now(),
      canRequest: false,
    };
    state.permissionStates.shell = permission;

    json(res, {
      enabled,
      ...permission,
      permission,
    });
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/permissions/")) {
    const permId = pathname.slice("/api/permissions/".length);
    if (!permId || permId.includes("/")) {
      error(res, "Invalid permission ID", 400);
      return true;
    }
    const permStates = state.permissionStates ?? {};
    const permState = permStates[permId];
    if (!permState) {
      json(res, {
        id: permId,
        status: "not-applicable",
        lastChecked: Date.now(),
        canRequest: false,
      });
      return true;
    }
    json(res, permState);
    return true;
  }

  if (method === "POST" && pathname === "/api/permissions/refresh") {
    json(res, {
      message: "Permission refresh requested",
      action: "ipc:permissions:refresh",
    });
    return true;
  }

  if (
    method === "POST" &&
    pathname.match(/^\/api\/permissions\/[^/]+\/request$/)
  ) {
    const permId = pathname.split("/")[3];
    json(res, {
      message: `Permission request for ${permId}`,
      action: `ipc:permissions:request:${permId}`,
    });
    return true;
  }

  if (
    method === "POST" &&
    pathname.match(/^\/api\/permissions\/[^/]+\/open-settings$/)
  ) {
    const permId = pathname.split("/")[3];
    json(res, {
      message: `Opening settings for ${permId}`,
      action: `ipc:permissions:openSettings:${permId}`,
    });
    return true;
  }

  if (method === "PUT" && pathname === "/api/permissions/shell") {
    const body = await readJsonBody<{ enabled?: boolean }>(req, res);
    if (!body) return true;
    const enabled = body.enabled === true;
    state.shellEnabled = enabled;

    if (!state.permissionStates) {
      state.permissionStates = {};
    }
    state.permissionStates.shell = {
      id: "shell",
      status: enabled ? "granted" : "denied",
      lastChecked: Date.now(),
      canRequest: false,
    };

    if (!state.config.features) {
      state.config.features = {};
    }
    state.config.features.shellEnabled = enabled;
    saveConfig(state.config);

    if (state.runtime) {
      scheduleRuntimeRestart(
        `Shell access ${enabled ? "enabled" : "disabled"}`,
      );
    }

    json(res, {
      shellEnabled: enabled,
      permission: state.permissionStates.shell,
    });
    return true;
  }

  if (method === "PUT" && pathname === "/api/permissions/state") {
    const body = await readJsonBody<{
      permissions?: Record<string, PermissionState>;
      startup?: boolean;
    }>(req, res);
    if (!body) return true;

    if (body.permissions && typeof body.permissions === "object") {
      state.permissionStates = body.permissions;

      let configChanged = false;
      state.config.plugins = state.config.plugins || {};
      state.config.plugins.entries = state.config.plugins.entries || {};

      const capabilities = [
        { id: "browser", required: ["accessibility"] },
        { id: "computeruse", required: ["accessibility", "screen-recording"] },
        { id: "vision", required: ["screen-recording"] },
        { id: "coding-agent", required: [] },
      ];

      for (const cap of capabilities) {
        if (state.config.plugins.entries[cap.id]?.enabled === undefined) {
          const allGranted = cap.required.every((permId) => {
            const pStatus = state.permissionStates?.[permId]?.status;
            return pStatus === "granted" || pStatus === "not-applicable";
          });

          if (allGranted) {
            state.config.plugins.entries[cap.id] = {
              ...(state.config.plugins.entries[cap.id] || {}),
              enabled: true,
            };
            configChanged = true;
          }
        }
      }

      if (configChanged) {
        saveConfig(state.config);
        if (state.runtime && !body.startup) {
          scheduleRuntimeRestart("Auto-enabled newly permitted capabilities");
        }
      }
    }

    json(res, { updated: true, permissions: state.permissionStates });
    return true;
  }

  return false;
}
