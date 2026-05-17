import type { ExistingElizaInstallInfo } from "../types/index.js";
export type ElectrobunRequestHandler = (params?: unknown) => Promise<unknown>;
export type ElectrobunMessageListener = (payload: unknown) => void;
export interface ElectrobunRendererRpc {
  request: Record<string, ElectrobunRequestHandler>;
  onMessage: (messageName: string, listener: ElectrobunMessageListener) => void;
  offMessage: (
    messageName: string,
    listener: ElectrobunMessageListener,
  ) => void;
}
export declare function getElectrobunRendererRpc():
  | ElectrobunRendererRpc
  | undefined;
export declare function invokeDesktopBridgeRequest<T>(options: {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
}): Promise<T | null>;
export type DesktopBridgeTimeoutResult<T> =
  | {
      status: "ok";
      value: T;
    }
  | {
      status: "missing";
    }
  | {
      status: "timeout";
    }
  | {
      status: "rejected";
      error: unknown;
    };
/**
 * Same as `invokeDesktopBridgeRequest`, but never hangs past `timeoutMs`.
 * Use after native dialogs when a missing or wedged RPC would freeze the UI.
 */
export declare function invokeDesktopBridgeRequestWithTimeout<T>(options: {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
  timeoutMs: number;
}): Promise<DesktopBridgeTimeoutResult<T>>;
export interface DetectedProvider {
  id: string;
  source: string;
  apiKey?: string;
  authMode?: string;
  cliInstalled: boolean;
  status?: string;
}
export interface DesktopRuntimeModeInfo {
  mode: "local" | "external" | "disabled";
  externalApiBase?: string | null;
  externalApiSource?: string | null;
}
export type DesktopCarrotPermissionTag =
  | `host:${"windows" | "tray" | "notifications" | "storage" | "manage-carrots"}`
  | `bun:${"read" | "write" | "env" | "run" | "ffi" | "addons" | "worker"}`
  | `isolation:${"shared-worker" | "isolated-process"}`;
export interface DesktopCarrotPermissionGrant {
  host?: Partial<
    Record<
      "windows" | "tray" | "notifications" | "storage" | "manage-carrots",
      boolean
    >
  >;
  bun?: Partial<
    Record<
      "read" | "write" | "env" | "run" | "ffi" | "addons" | "worker",
      boolean
    >
  >;
  isolation?: "shared-worker" | "isolated-process";
}
export interface DesktopCarrotViewInfo {
  relativePath: string;
  hidden?: boolean;
  title: string;
  width: number;
  height: number;
  titleBarStyle?: "hidden" | "hiddenInset" | "default";
  transparent?: boolean;
  viewUrl: string;
}
export interface DesktopCarrotListEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: "window" | "background";
  permissions: DesktopCarrotPermissionTag[];
  status: "installed" | "broken";
  devMode: boolean;
}
export interface DesktopInstalledCarrotSnapshot {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: "window" | "background";
  status: "installed" | "broken";
  sourceKind: "prototype" | "local" | "artifact";
  currentHash: string | null;
  installedAt: number;
  updatedAt: number;
  devMode: boolean;
  lastBuildAt: number | null;
  lastBuildError: string | null;
  requestedPermissions: DesktopCarrotPermissionGrant;
  grantedPermissions: DesktopCarrotPermissionGrant;
  view: DesktopCarrotViewInfo;
  worker: {
    relativePath: string;
  };
  remoteUIs?: Record<
    string,
    {
      name: string;
      path: string;
    }
  >;
}
export interface DesktopCarrotStoreSnapshot {
  version: 1;
  carrots: DesktopInstalledCarrotSnapshot[];
}
export type DesktopCarrotWorkerState =
  | "stopped"
  | "starting"
  | "running"
  | "error";
export interface DesktopCarrotWorkerStatus {
  id: string;
  state: DesktopCarrotWorkerState;
  startedAt: number | null;
  stoppedAt: number | null;
  error: string | null;
}
export interface DesktopCarrotLogsSnapshot {
  id: string;
  path: string;
  text: string;
  truncated: boolean;
}
export interface WorkspaceFolderPickResult {
  canceled: boolean;
  path: string;
  bookmark: string | null;
}
export interface StateDirMigrationResult {
  ok: boolean;
  migrated: boolean;
  fromPath: string;
  toPath: string;
  error?: string;
  skippedReason?: "same-path" | "source-missing" | "source-not-directory";
}
export interface WorkspaceFolderBookmarkResolveResult {
  ok: boolean;
  path: string;
  stale?: boolean;
  error?: string;
}
export declare function scanProviderCredentials(): Promise<DetectedProvider[]>;
export declare function inspectExistingElizaInstall(): Promise<ExistingElizaInstallInfo | null>;
export declare function pickDesktopWorkspaceFolder(options?: {
  defaultPath?: string;
  promptTitle?: string;
}): Promise<WorkspaceFolderPickResult | null>;
export declare function desktopOpenPath(path: string): Promise<void>;
export declare function desktopShowItemInFolder(path: string): Promise<void>;
export declare function migrateDesktopStateDir(
  fromPath: string,
): Promise<StateDirMigrationResult | null>;
export declare function resolveDesktopWorkspaceFolderBookmark(
  bookmark: string,
): Promise<WorkspaceFolderBookmarkResolveResult | null>;
export declare function releaseDesktopWorkspaceFolderBookmarks(): Promise<{
  ok: true;
} | null>;
export declare function getDesktopRuntimeMode(): Promise<DesktopRuntimeModeInfo | null>;
export declare function getDesktopCarrotStoreRoot(): Promise<string | null>;
export declare function listDesktopCarrots(): Promise<
  DesktopCarrotListEntry[] | null
>;
export declare function getDesktopCarrotStoreSnapshot(): Promise<DesktopCarrotStoreSnapshot | null>;
export declare function getDesktopCarrot(
  id: string,
): Promise<DesktopInstalledCarrotSnapshot | null>;
export declare function installDesktopCarrotFromDirectory(options: {
  sourceDir: string;
  devMode?: boolean;
  permissionsGranted?: DesktopCarrotPermissionGrant;
}): Promise<DesktopInstalledCarrotSnapshot | null>;
export declare function uninstallDesktopCarrot(id: string): Promise<{
  removed: boolean;
  carrot: DesktopCarrotListEntry | null;
} | null>;
export declare function startDesktopCarrotWorker(
  id: string,
): Promise<DesktopCarrotWorkerStatus | null>;
export declare function stopDesktopCarrotWorker(
  id: string,
): Promise<DesktopCarrotWorkerStatus | null>;
export declare function getDesktopCarrotWorkerStatus(
  id: string,
): Promise<DesktopCarrotWorkerStatus | null>;
export declare function listDesktopCarrotWorkerStatuses(): Promise<
  DesktopCarrotWorkerStatus[] | null
>;
export declare function getDesktopCarrotLogs(
  id: string,
  maxBytes?: number,
): Promise<DesktopCarrotLogsSnapshot | null>;
export declare function subscribeDesktopBridgeEvent(options: {
  rpcMessage: string;
  ipcChannel: string;
  listener: ElectrobunMessageListener;
}): () => void;
export declare function subscribeDesktopCarrotStoreChanged(
  listener: (snapshot: DesktopCarrotStoreSnapshot) => void,
): () => void;
export declare function subscribeDesktopCarrotWorkerChanged(
  listener: (status: DesktopCarrotWorkerStatus) => void,
): () => void;
//# sourceMappingURL=electrobun-rpc.d.ts.map
