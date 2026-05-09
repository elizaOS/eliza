import type { AgentRuntime, RouteRequestContext } from "@elizaos/core";
import type { PermissionState, SystemPermissionId } from "@elizaos/shared";
import type { AutonomousConfigLike } from "../types/config-like.js";

interface PermissionAutonomousConfigLike extends AutonomousConfigLike {
  features?: {
    shellEnabled?: boolean;
  };
  plugins?: {
    entries?: Record<string, { enabled?: boolean }>;
  };
}

const WEBSITE_BLOCKING_PERMISSION_ID = "website-blocking";

const ALL_PERMISSION_IDS: readonly SystemPermissionId[] = [
  "accessibility",
  "screen-recording",
  "microphone",
  "camera",
  "shell",
  "website-blocking",
  "location",
];

type SelfControlApi = {
  getSelfControlPermissionState: () => Promise<PermissionState>;
  requestSelfControlPermission: () => Promise<PermissionState>;
  openSelfControlPermissionLocation: () => Promise<boolean>;
};

const SELFCONTROL_MODULE: string = "@elizaos/app-lifeops/selfcontrol";

async function loadSelfControlApi(): Promise<SelfControlApi | null> {
  try {
    const loaded = (await import(
      /* @vite-ignore */ SELFCONTROL_MODULE
    )) as Partial<SelfControlApi>;
    if (
      typeof loaded.getSelfControlPermissionState !== "function" ||
      typeof loaded.requestSelfControlPermission !== "function" ||
      typeof loaded.openSelfControlPermissionLocation !== "function"
    ) {
      return null;
    }
    return loaded as SelfControlApi;
  } catch {
    return null;
  }
}

function unavailableWebsiteBlockingPermission(): PermissionState {
  return {
    id: WEBSITE_BLOCKING_PERMISSION_ID,
    status: "not-applicable",
    lastChecked: Date.now(),
    canRequest: false,
    reason: "Website blocking is available when the LifeOps app is installed.",
  };
}

function unavailableSystemPermission(id: SystemPermissionId): PermissionState {
  return {
    id,
    status: "not-applicable",
    lastChecked: Date.now(),
    canRequest: false,
    reason: "Native permission checks are unavailable in this runtime.",
  };
}

function buildPermissionsPayload(
  state: PermissionRouteState,
  websiteBlockingPermission: PermissionState,
): Record<SystemPermissionId, PermissionState> & {
  _platform: NodeJS.Platform;
  _shellEnabled: boolean;
} {
  const permissionStates = state.permissionStates ?? {};
  const shellEnabled = state.shellEnabled ?? true;
  const permissions = {} as Record<SystemPermissionId, PermissionState>;

  for (const id of ALL_PERMISSION_IDS) {
    permissions[id] = permissionStates[id] ?? unavailableSystemPermission(id);
  }

  permissions.shell = {
    ...permissions.shell,
    status: shellEnabled ? "granted" : "denied",
    canRequest: false,
  };
  permissions[WEBSITE_BLOCKING_PERMISSION_ID] = websiteBlockingPermission;

  return {
    ...permissions,
    _platform: process.platform,
    _shellEnabled: shellEnabled,
  };
}

async function getWebsiteBlockingPermissionState(): Promise<PermissionState> {
  const selfControl = await loadSelfControlApi();
  return selfControl
    ? await selfControl.getSelfControlPermissionState()
    : unavailableWebsiteBlockingPermission();
}

export interface PermissionRouteState {
  runtime: AgentRuntime | null;
  config: PermissionAutonomousConfigLike;
  permissionStates?: Record<string, PermissionState>;
  shellEnabled?: boolean;
}

export interface PermissionRouteContext extends RouteRequestContext {
  state: PermissionRouteState;
  saveConfig: (config: PermissionAutonomousConfigLike) => void;
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
    const websiteBlockingPermission = await getWebsiteBlockingPermissionState();
    json(res, buildPermissionsPayload(state, websiteBlockingPermission));
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
    if (permId === WEBSITE_BLOCKING_PERMISSION_ID) {
      json(res, await getWebsiteBlockingPermissionState());
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
    const websiteBlockingPermission = await getWebsiteBlockingPermissionState();
    json(res, buildPermissionsPayload(state, websiteBlockingPermission));
    return true;
  }

  if (
    method === "POST" &&
    pathname.match(/^\/api\/permissions\/[^/]+\/request$/)
  ) {
    const permId = pathname.split("/")[3];
    if (permId === WEBSITE_BLOCKING_PERMISSION_ID) {
      const selfControl = await loadSelfControlApi();
      json(
        res,
        selfControl
          ? await selfControl.requestSelfControlPermission()
          : unavailableWebsiteBlockingPermission(),
      );
      return true;
    }
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
    if (permId === WEBSITE_BLOCKING_PERMISSION_ID) {
      try {
        const selfControl = await loadSelfControlApi();
        const opened = selfControl
          ? await selfControl.openSelfControlPermissionLocation()
          : false;
        json(res, {
          opened,
          id: WEBSITE_BLOCKING_PERMISSION_ID,
          permission: await getWebsiteBlockingPermissionState(),
        });
      } catch (openError) {
        error(
          res,
          openError instanceof Error
            ? openError.message
            : "Failed to open the hosts file location.",
          500,
        );
      }
      return true;
    }
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
