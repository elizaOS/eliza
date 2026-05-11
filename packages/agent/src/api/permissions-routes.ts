import type { AgentRuntime, RouteRequestContext } from "@elizaos/core";
import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionState,
} from "@elizaos/shared";
import {
  getMacPermissionDeepLink,
  isPermissionId,
  PERMISSION_IDS,
} from "@elizaos/shared";
import { PERMISSIONS_REGISTRY_SERVICE } from "../services/permissions-registry.ts";
import type { AutonomousConfigLike } from "../types/config-like.ts";

interface PermissionAutonomousConfigLike extends AutonomousConfigLike {
  features?: {
    shellEnabled?: boolean;
  };
  plugins?: {
    entries?: Record<string, { enabled?: boolean }>;
  };
}

const WEBSITE_BLOCKING_PERMISSION_ID = "website-blocking";

type SelfControlApi = {
  getSelfControlPermissionState: () => Promise<PermissionState>;
  requestSelfControlPermission: () => Promise<PermissionState>;
  openSelfControlPermissionLocation: () => Promise<boolean>;
};

const SELFCONTROL_MODULE: string = "@elizaos/app-lifeops";

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

function currentPlatform(): "darwin" | "win32" | "linux" {
  const p = process.platform;
  return p === "darwin" || p === "win32" || p === "linux" ? p : "linux";
}

function getPermissionRegistry(
  runtime: AgentRuntime | null,
): IPermissionsRegistry | null {
  const service = runtime?.getService(PERMISSIONS_REGISTRY_SERVICE);
  return service &&
    typeof service === "object" &&
    "get" in service &&
    "check" in service &&
    "request" in service
    ? (service as unknown as IPermissionsRegistry)
    : null;
}

function unavailableWebsiteBlockingPermission(): PermissionState {
  return {
    id: WEBSITE_BLOCKING_PERMISSION_ID,
    status: "not-applicable",
    lastChecked: Date.now(),
    canRequest: false,
    platform: currentPlatform(),
    reason: "Website blocking is available when the LifeOps app is installed.",
  };
}

function unavailableSystemPermission(id: PermissionId): PermissionState {
  return {
    id,
    status: "not-applicable",
    lastChecked: Date.now(),
    canRequest: false,
    platform: currentPlatform(),
    reason: "Native permission checks are unavailable in this runtime.",
  };
}

async function openSystemPermissionSettings(
  id: PermissionId,
): Promise<boolean> {
  const platform = currentPlatform();
  let argv: string[] | null = null;

  if (platform === "darwin") {
    argv = ["open", getMacPermissionDeepLink(id)];
  } else if (platform === "win32") {
    const settingsMap: Partial<Record<PermissionId, string>> = {
      microphone: "ms-settings:privacy-microphone",
      camera: "ms-settings:privacy-webcam",
      location: "ms-settings:privacy-location",
      notifications: "ms-settings:notifications",
    };
    const uri = settingsMap[id];
    if (uri) argv = ["cmd", "/c", "start", "", uri];
  } else {
    const settingsMap: Partial<Record<PermissionId, string>> = {
      microphone: "privacy",
      camera: "privacy",
      location: "privacy",
      notifications: "notifications",
    };
    const panel = settingsMap[id];
    if (panel) argv = ["sh", "-lc", `gnome-control-center ${panel}`];
  }

  if (!argv) return false;
  try {
    const { spawn } = await import("node:child_process");
    const proc = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

async function buildPermissionsPayload(
  state: PermissionRouteState,
  websiteBlockingPermission: PermissionState,
  refresh = false,
): Promise<
  Record<PermissionId, PermissionState> & {
    _platform: NodeJS.Platform;
    _shellEnabled: boolean;
  }
> {
  const permissionStates = state.permissionStates ?? {};
  const shellEnabled = state.shellEnabled ?? true;
  const registry = getPermissionRegistry(state.runtime);
  const permissions = {} as Record<PermissionId, PermissionState>;

  await Promise.all(
    PERMISSION_IDS.map(async (id) => {
      if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
        permissions[id] = websiteBlockingPermission;
        return;
      }

      const persisted = permissionStates[id];
      if (!refresh && persisted) {
        permissions[id] = persisted;
        return;
      }

      if (registry) {
        try {
          permissions[id] = refresh
            ? await registry.check(id)
            : registry.get(id);
          return;
        } catch {
          // Fall through to persisted/unavailable state.
        }
      }

      permissions[id] = persisted ?? unavailableSystemPermission(id);
    }),
  );

  if (!permissions.shell) {
    permissions.shell = unavailableSystemPermission("shell");
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
    json(res, await buildPermissionsPayload(state, websiteBlockingPermission));
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
      platform: currentPlatform(),
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
    if (!permId || permId.includes("/") || !isPermissionId(permId)) {
      error(res, "Invalid permission ID", 400);
      return true;
    }
    if (permId === WEBSITE_BLOCKING_PERMISSION_ID) {
      json(res, await getWebsiteBlockingPermissionState());
      return true;
    }
    const permState = state.permissionStates?.[permId];
    if (permState) {
      json(res, permState);
      return true;
    }
    const registry = getPermissionRegistry(state.runtime);
    if (registry) {
      try {
        json(res, registry.get(permId));
        return true;
      } catch {
        // Fall through to persisted/unavailable state.
      }
    }
    json(res, unavailableSystemPermission(permId));
    return true;
  }

  if (method === "POST" && pathname === "/api/permissions/refresh") {
    const websiteBlockingPermission = await getWebsiteBlockingPermissionState();
    json(
      res,
      await buildPermissionsPayload(state, websiteBlockingPermission, true),
    );
    return true;
  }

  if (
    method === "POST" &&
    pathname.match(/^\/api\/permissions\/[^/]+\/request$/)
  ) {
    const permId = pathname.split("/")[3];
    if (!isPermissionId(permId)) {
      error(res, "Invalid permission ID", 400);
      return true;
    }
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
    const registry = getPermissionRegistry(state.runtime);
    if (registry) {
      try {
        json(
          res,
          await registry.request(permId, {
            reason: "Requested from permissions API.",
            feature: { app: "settings", action: `request.${permId}` },
          }),
        );
        return true;
      } catch {
        // Fall through to bridge hint for runtimes without a prober.
      }
    }
    json(res, unavailableSystemPermission(permId));
    return true;
  }

  if (
    method === "POST" &&
    pathname.match(/^\/api\/permissions\/[^/]+\/open-settings$/)
  ) {
    const permId = pathname.split("/")[3];
    if (!isPermissionId(permId)) {
      error(res, "Invalid permission ID", 400);
      return true;
    }
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
    const opened = await openSystemPermissionSettings(permId);
    json(res, {
      opened,
      id: permId,
      permission:
        state.permissionStates?.[permId] ?? unavailableSystemPermission(permId),
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
      platform: currentPlatform(),
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
