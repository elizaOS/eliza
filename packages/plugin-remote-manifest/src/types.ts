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
  | WorkerReadyMessage
  // Plugin/mode unification (P0): forward-looking message types used by the
  // surface-parity wire envelope. P0 ships only the type spine; P1 wires the
  // runtime dispatch for action / provider / event / model surfaces, P2
  // adds service / route / view dispatch, P3 adds agent-generated plugins.
  | WorkerAnnouncePluginMessage
  | WorkerAnnounceDynamicMessage
  | WorkerInitCompleteMessage
  | WorkerRpcMessage
  | WorkerRpcResultMessage
  | HostRpcMessage
  | HostRpcResultMessage
  | StreamChunkMessage
  | StreamEndMessage;

/**
 * Forward-looking wire envelope for the unified Plugin/mode design.
 *
 * The transport (Worker postMessage locally; HTTPS for cloud-hosted remote
 * plugins) speaks the same JSON envelope. Switching transport is a
 * constructor argument in `RemotePluginHost`, not a code change.
 *
 * See packages/agent/docs/capability-router-remote-plugins.md and the P0
 * architecture review for the complete protocol design.
 */
export type PluginSurfaceKind =
  | "action"
  | "provider"
  | "service"
  | "model"
  | "event"
  | "route"
  | "evaluator"
  | "tests";

/** Tag pointing to a function that lives on the worker side; surfaced in the announce payload. */
export interface RemoteFunctionRef {
  rpc: true;
  /** Stable id assigned by the worker bootstrap. */
  id: string;
}

/**
 * Sent once by the worker after `ready`. Describes the full {@link Plugin}
 * object the worker exports, with every function value replaced by a
 * {@link RemoteFunctionRef}. The host uses this to synthesise local stubs
 * (action handlers, provider getters, service-method proxies, etc.) that
 * forward calls to the worker via {@link WorkerRpcMessage}.
 */
export interface WorkerAnnouncePluginMessage {
  type: "worker-announce-plugin";
  /** JSON descriptor of the Plugin object, with `{ rpc, id }` in lieu of fns. */
  descriptor: JsonObject;
}

/**
 * Sent by the worker bootstrap after the author's `Plugin.init(...)` has
 * returned, carrying any surface registrations that `init` made
 * dynamically (e.g. calls to runtime.registerProvider). The host applies
 * these atomically and the {@link WorkerInitCompleteMessage} follows.
 */
export interface WorkerAnnounceDynamicMessage {
  type: "worker-announce-dynamic";
  descriptor: JsonObject;
}

/** Sent by the worker once `init()` returns; signals the plugin is live. */
export interface WorkerInitCompleteMessage {
  type: "init-complete";
}

/** Host → worker: invoke a registered surface on the worker. */
export interface WorkerRpcMessage {
  type: "worker-rpc";
  requestId: number;
  surface: PluginSurfaceKind;
  /** Surface-specific target, e.g. action name, `serviceType.method`, route id. */
  target: string;
  args: JsonValue;
  /** When true, reply is delivered as a stream of {@link StreamChunkMessage}. */
  streamReply?: boolean;
}

/** Worker → host: result for a {@link WorkerRpcMessage}. */
export interface WorkerRpcResultMessage {
  type: "worker-rpc-result";
  requestId: number;
  ok: boolean;
  /** Present on success when `streamReply !== true`. */
  payload?: JsonValue;
  /** Present on success when `streamReply === true`; consume via stream-chunk/-end. */
  streamId?: string;
  /** Present when `ok === false`. */
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: JsonValue;
    code?: string;
  };
}

/**
 * Worker → host: call a method on the host-side `RuntimeProxy`. Subsumes the
 * existing {@link HostRequestMessage} channel for action-style operations
 * (open-file-dialog, list-remote-plugins, etc.) while also supporting
 * full runtime API access: `runtime.getService`, `runtime.useModel`,
 * `runtime.getMemory`, `runtime.emitEvent`, etc.
 */
export interface HostRpcMessage {
  type: "host-rpc";
  requestId: number;
  /** API namespace; "runtime" is the only namespace today. */
  api: "runtime";
  method: string;
  args: JsonValue;
  streamReply?: boolean;
}

/** Host → worker: result for a {@link HostRpcMessage}. */
export interface HostRpcResultMessage {
  type: "host-rpc-result";
  requestId: number;
  ok: boolean;
  payload?: JsonValue;
  streamId?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: JsonValue;
    code?: string;
  };
}

/** Either direction: next chunk for an open stream. */
export interface StreamChunkMessage {
  type: "stream-chunk";
  streamId: string;
  chunk: JsonValue;
}

/** Either direction: terminal message for a stream. */
export interface StreamEndMessage {
  type: "stream-end";
  streamId: string;
  /** Optional terminal value (single-shot result). */
  value?: JsonValue;
  /** Optional error; mutually exclusive with `value`. */
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: JsonValue;
    code?: string;
  };
}

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
