export const HOST_PERMISSIONS = [
  "windows",
  "tray",
  "notifications",
  "storage",
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

export const CARROT_ISOLATIONS = ["shared-worker", "isolated-process"] as const;

export type HostPermission = (typeof HOST_PERMISSIONS)[number];
export type BunPermission = (typeof BUN_PERMISSIONS)[number];
export type CarrotIsolation = (typeof CARROT_ISOLATIONS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type LegacyCarrotPermission =
  | "bun"
  | "bun:fs"
  | "bun:env"
  | "bun:child_process"
  | "bun:ffi"
  | "bun:addons"
  | HostPermission;

export interface CarrotPermissionGrant {
  host?: Partial<Record<HostPermission, boolean>>;
  bun?: Partial<Record<BunPermission, boolean>>;
  isolation?: CarrotIsolation;
}

export type CarrotPermissionTag =
  | `host:${HostPermission}`
  | `bun:${BunPermission}`
  | `isolation:${CarrotIsolation}`;

export interface CarrotPermissionConsentRequest {
  requestId: string;
  carrotId: string;
  carrotName: string;
  version: string;
  sourceKind: "prototype" | "local" | "artifact";
  sourceLabel: string;
  message: string;
  confirmLabel: string;
  requestedPermissions: CarrotPermissionTag[];
  changedPermissions: CarrotPermissionTag[];
  hostPermissions: HostPermission[];
  bunPermissions: BunPermission[];
  isolation: CarrotIsolation;
}

export type CarrotMode = "window" | "background";
export type CarrotDependencyMap = Record<string, string>;

export interface CarrotRemoteUI {
  name: string;
  path: string;
}

export interface CarrotViewManifest {
  relativePath: string;
  hidden?: boolean;
  title: string;
  width: number;
  height: number;
  titleBarStyle?: "hidden" | "hiddenInset" | "default";
  transparent?: boolean;
}

export interface CarrotWorkerManifest {
  relativePath: string;
}

export interface CarrotManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  mode: CarrotMode;
  dependencies?: CarrotDependencyMap;
  permissions: CarrotPermissionGrant;
  view: CarrotViewManifest;
  worker: CarrotWorkerManifest;
  remoteUIs?: Record<string, CarrotRemoteUI>;
}

export type CarrotInstallSource =
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

export type CarrotInstallStatus = "installed" | "broken";

export interface CarrotInstallRecord {
  id: string;
  name: string;
  version: string;
  currentHash: string | null;
  installedAt: number;
  updatedAt: number;
  permissionsGranted: CarrotPermissionGrant;
  devMode?: boolean;
  lastBuildAt?: number | null;
  lastBuildError?: string | null;
  status: CarrotInstallStatus;
  source: CarrotInstallSource;
}

export interface CarrotRegistry {
  version: 1;
  carrots: Record<string, CarrotInstallRecord>;
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
  manifest: CarrotManifest;
  context: {
    statePath: string;
    logsPath: string;
    permissions: CarrotPermissionTag[];
    grantedPermissions: CarrotPermissionGrant;
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
  | "stop-carrot"
  | "emit-view"
  | "emit-carrot-event"
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
  | "invoke-carrot"
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

export type CarrotWorkerMessage =
  | WorkerRequestMessage
  | WorkerEventMessage
  | WorkerInitMessage
  | HostActionMessage
  | HostRequestMessage
  | HostResponseMessage
  | WorkerResponseMessage
  | WorkerReadyMessage;

export interface CarrotViewRPC {
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
      carrotBoot: {
        id: string;
        name: string;
        permissions: CarrotPermissionTag[];
        grantedPermissions: CarrotPermissionGrant;
        mode: CarrotMode;
      };
    };
  };
}

export interface CarrotRuntimeContext {
  currentDir: string;
  statePath: string;
  logsPath: string;
  permissions: CarrotPermissionTag[];
  grantedPermissions: CarrotPermissionGrant;
  authToken: string | null;
  channel: string;
}

export interface CarrotListEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: CarrotMode;
  permissions: CarrotPermissionTag[];
  status: CarrotInstallStatus;
  devMode: boolean;
}
