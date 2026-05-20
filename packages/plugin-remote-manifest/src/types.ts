export const HOST_PERMISSIONS = [
  "windows",
  "tray",
  "notifications",
  "storage",
  "manage-remote-plugins",
] as const;

export const BUN_PERMISSIONS = [
  "read",
  "write",
  "env",
  "run",
  "ffi",
  "addons",
  "worker",
] as const;

export const REMOTE_PLUGIN_ISOLATIONS = ["shared-worker", "isolated-process"] as const;

export type HostPermission = (typeof HOST_PERMISSIONS)[number];
export type BunPermission = (typeof BUN_PERMISSIONS)[number];
export type RemotePluginIsolation = (typeof REMOTE_PLUGIN_ISOLATIONS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type LegacyRemotePluginPermission =
  | "bun"
  | "bun:fs"
  | "bun:env"
  | "bun:child_process"
  | "bun:ffi"
  | "bun:addons"
  | HostPermission;

export interface RemotePluginPermissionGrant {
  host?: Partial<Record<HostPermission, boolean>>;
  bun?: Partial<Record<BunPermission, boolean>>;
  isolation?: RemotePluginIsolation;
}

export type RemotePluginPermissionTag =
  | `host:${HostPermission}`
  | `bun:${BunPermission}`
  | `isolation:${RemotePluginIsolation}`;

export interface RemotePluginPermissionConsentRequest {
  requestId: string;
  remotePluginId: string;
  remotePluginName: string;
  version: string;
  sourceKind: "prototype" | "local" | "artifact";
  sourceLabel: string;
  message: string;
  confirmLabel: string;
  requestedPermissions: RemotePluginPermissionTag[];
  changedPermissions: RemotePluginPermissionTag[];
  hostPermissions: HostPermission[];
  bunPermissions: BunPermission[];
  isolation: RemotePluginIsolation;
}

export type RemotePluginViewMode = "window" | "background";
export type RemotePluginDependencyMap = Record<string, string>;

export interface RemotePluginRemoteUI {
  name: string;
  path: string;
}

export interface RemotePluginViewManifest {
  relativePath: string;
  hidden?: boolean;
  title: string;
  width: number;
  height: number;
  titleBarStyle?: "hidden" | "hiddenInset" | "default";
  transparent?: boolean;
}

export interface RemotePluginWorkerManifest {
  relativePath: string;
}

export interface RemotePluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  mode: RemotePluginViewMode;
  dependencies?: RemotePluginDependencyMap;
  permissions: RemotePluginPermissionGrant;
  view: RemotePluginViewManifest;
  worker: RemotePluginWorkerManifest;
  remoteUIs?: Record<string, RemotePluginRemoteUI>;
}

export type RemotePluginInstallSource =
  | {
      kind: "prototype";
      prototypeId: string;
      bundledViewFolder: string;
    }
  | {
      kind: "local";
      path: string;
    }
  | {
      kind: "artifact";
      location: string;
      updateLocation?: string | null;
      tarballLocation?: string | null;
      currentHash?: string | null;
      baseUrl?: string | null;
    };

export type RemotePluginInstallStatus = "installed" | "broken";

export interface RemotePluginInstallRecord {
  id: string;
  name: string;
  version: string;
  currentHash: string | null;
  installedAt: number;
  updatedAt: number;
  permissionsGranted: RemotePluginPermissionGrant;
  devMode?: boolean;
  lastBuildAt?: number | null;
  lastBuildError?: string | null;
  status: RemotePluginInstallStatus;
  source: RemotePluginInstallSource;
}

export interface RemotePluginRegistry {
  version: 1;
  remotePlugins: Record<string, RemotePluginInstallRecord>;
}

export interface WorkerRequestMessage {
  type: "request";
  requestId: number;
  method: string;
  params?: JsonValue;
  windowId?: string;
}

export interface WorkerEventMessage {
  type: "event";
  name: string;
  payload?: JsonValue;
}

export interface WorkerInitMessage {
  type: "init";
  manifest: RemotePluginManifest;
  context: {
    statePath: string;
    logsPath: string;
    permissions: RemotePluginPermissionTag[];
    grantedPermissions: RemotePluginPermissionGrant;
    config?: JsonObject;
  };
}

export type HostAction =
  | "notify"
  | "window-create"
  | "window-set-title"
  | "window-set-frame"
  | "window-set-always-on-top"
  | "show-context-menu"
  | "set-application-menu"
  | "clear-application-menu"
  | "set-tray"
  | "set-tray-menu"
  | "remove-tray"
  | "focus-window"
  | "close-window"
  | "open-bunny-window"
  | "open-manager"
  | "stop-remote-plugin"
  | "emit-view"
  | "emit-remote-plugin-event"
  | "log";

export interface HostActionMessage {
  type: "action";
  action: HostAction;
  payload?: JsonValue;
}

export type HostRequestMethod =
  | "open-file-dialog"
  | "open-path"
  | "show-item-in-folder"
  | "clipboard-write-text"
  | "window-get-frame"
  | "invoke-remote-plugin"
  | "list-remote-plugins"
  | "start-remote-plugin"
  | "stop-remote-plugin"
  | "get-auth-token"
  | "set-auth-token"
  | "screen-get-primary-display"
  | "screen-get-cursor-screen-point";

export interface HostRequestMessage {
  type: "host-request";
  requestId: number;
  method: HostRequestMethod;
  params?: JsonValue;
}

export interface HostResponseMessage {
  type: "host-response";
  requestId: number;
  success: boolean;
  payload?: JsonValue;
  error?: string;
}

export interface WorkerResponseMessage {
  type: "response";
  requestId: number;
  success: boolean;
  payload?: JsonValue;
  error?: string;
}

export interface WorkerReadyMessage {
  type: "ready";
}

export type RemotePluginWorkerMessage =
  | WorkerRequestMessage
  | WorkerEventMessage
  | WorkerInitMessage
  | HostActionMessage
  | HostRequestMessage
  | HostResponseMessage
  | WorkerResponseMessage
  | WorkerReadyMessage;

export interface RemotePluginViewRPC {
  bun: {
    requests: {
      invoke: {
        params: { method: string; params?: JsonValue };
        response: JsonValue;
      };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      runtimeEvent: { name: string; payload?: JsonValue };
      remotePluginBoot: {
        id: string;
        name: string;
        permissions: RemotePluginPermissionTag[];
        grantedPermissions: RemotePluginPermissionGrant;
        mode: RemotePluginViewMode;
      };
    };
  };
}

export interface RemotePluginRuntimeContext {
  currentDir: string;
  statePath: string;
  logsPath: string;
  permissions: RemotePluginPermissionTag[];
  grantedPermissions: RemotePluginPermissionGrant;
  authToken: string | null;
  channel: string;
}

export interface RemotePluginListEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: RemotePluginViewMode;
  permissions: RemotePluginPermissionTag[];
  status: RemotePluginInstallStatus;
  devMode: boolean;
}
