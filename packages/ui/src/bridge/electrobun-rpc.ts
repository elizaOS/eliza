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

interface DesktopBridgeWindow extends Window {
  __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
}

function getDesktopBridgeWindow(): DesktopBridgeWindow | null {
  const g = globalThis as typeof globalThis & { window?: DesktopBridgeWindow };
  if (typeof g.window !== "undefined") {
    return g.window;
  }
  if (typeof window !== "undefined") {
    return window as DesktopBridgeWindow;
  }
  return null;
}

export function getElectrobunRendererRpc(): ElectrobunRendererRpc | undefined {
  return getDesktopBridgeWindow()?.__ELIZA_ELECTROBUN_RPC__;
}

export async function invokeDesktopBridgeRequest<T>(options: {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
}): Promise<T | null> {
  const rpc = getElectrobunRendererRpc();
  const request = rpc?.request?.[options.rpcMethod];
  if (request && rpc?.request) {
    return (await request.call(rpc.request, options.params)) as T;
  }

  return null;
}

export type DesktopBridgeTimeoutResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "timeout" }
  | { status: "rejected"; error: unknown };

/**
 * Same as `invokeDesktopBridgeRequest`, but never hangs past `timeoutMs`.
 * Use after native dialogs when a missing or wedged RPC would freeze the UI.
 */
export async function invokeDesktopBridgeRequestWithTimeout<T>(options: {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
  timeoutMs: number;
}): Promise<DesktopBridgeTimeoutResult<T>> {
  const rpc = getElectrobunRendererRpc();
  const request = rpc?.request?.[options.rpcMethod];
  if (!request || !rpc?.request) {
    return { status: "missing" };
  }

  const call = request.call(rpc.request, options.params) as Promise<T>;
  let tid: ReturnType<typeof setTimeout> | undefined;
  type RaceWinner =
    | { tag: "done"; value: T }
    | { tag: "reject"; error: unknown }
    | { tag: "timeout" };
  const timeoutPromise = new Promise<RaceWinner>((resolve) => {
    tid = setTimeout(() => resolve({ tag: "timeout" }), options.timeoutMs);
  });
  const settledPromise: Promise<RaceWinner> = call.then(
    (value) => ({ tag: "done" as const, value: value as T }),
    (error: unknown) => ({ tag: "reject" as const, error }),
  );

  try {
    const winner = await Promise.race<RaceWinner>([
      settledPromise,
      timeoutPromise,
    ]);
    if (tid !== undefined) clearTimeout(tid);
    if (winner.tag === "timeout") return { status: "timeout" };
    if (winner.tag === "reject") {
      return { status: "rejected", error: winner.error };
    }
    return { status: "ok", value: winner.value };
  } catch (error) {
    if (tid !== undefined) clearTimeout(tid);
    return { status: "rejected", error };
  }
}

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
  | `host:${"windows" | "tray" | "notifications" | "storage"}`
  | `bun:${"read" | "write" | "env" | "run" | "ffi" | "addons" | "worker"}`
  | `isolation:${"shared-worker" | "isolated-process"}`;

export interface DesktopCarrotPermissionGrant {
  host?: Partial<
    Record<"windows" | "tray" | "notifications" | "storage", boolean>
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
  lastBuildAt: number | null;
  lastBuildError: string | null;
  requestedPermissions: DesktopCarrotPermissionGrant;
  grantedPermissions: DesktopCarrotPermissionGrant;
  view: DesktopCarrotViewInfo;
  worker: { relativePath: string };
  remoteUIs?: Record<string, { name: string; path: string }>;
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

export async function scanProviderCredentials(): Promise<DetectedProvider[]> {
  const result = await invokeDesktopBridgeRequest<{
    providers: DetectedProvider[];
  }>({
    rpcMethod: "credentialsScanProviders",
    ipcChannel: "credentials:scanProviders",
    params: { context: "onboarding" },
  });
  return result?.providers ?? [];
}

export async function inspectExistingElizaInstall(): Promise<ExistingElizaInstallInfo | null> {
  return invokeDesktopBridgeRequest<ExistingElizaInstallInfo>({
    rpcMethod: "agentInspectExistingInstall",
    ipcChannel: "agent:inspectExistingInstall",
  });
}

export async function pickDesktopWorkspaceFolder(options?: {
  defaultPath?: string;
  promptTitle?: string;
}): Promise<WorkspaceFolderPickResult | null> {
  return invokeDesktopBridgeRequest<WorkspaceFolderPickResult>({
    rpcMethod: "desktopPickWorkspaceFolder",
    ipcChannel: "desktop:pickWorkspaceFolder",
    params: options ?? {},
  });
}

export async function migrateDesktopStateDir(
  fromPath: string,
): Promise<StateDirMigrationResult | null> {
  return invokeDesktopBridgeRequest<StateDirMigrationResult>({
    rpcMethod: "agentMigrateStateDir",
    ipcChannel: "agent:migrateStateDir",
    params: { fromPath },
  });
}

export async function resolveDesktopWorkspaceFolderBookmark(
  bookmark: string,
): Promise<WorkspaceFolderBookmarkResolveResult | null> {
  return invokeDesktopBridgeRequest<WorkspaceFolderBookmarkResolveResult>({
    rpcMethod: "desktopResolveWorkspaceFolderBookmark",
    ipcChannel: "desktop:resolveWorkspaceFolderBookmark",
    params: { bookmark },
  });
}

export async function releaseDesktopWorkspaceFolderBookmarks(): Promise<{
  ok: true;
} | null> {
  return invokeDesktopBridgeRequest<{ ok: true }>({
    rpcMethod: "desktopReleaseWorkspaceFolderBookmarks",
    ipcChannel: "desktop:releaseWorkspaceFolderBookmarks",
  });
}

export async function getDesktopRuntimeMode(): Promise<DesktopRuntimeModeInfo | null> {
  return invokeDesktopBridgeRequest<DesktopRuntimeModeInfo>({
    rpcMethod: "desktopGetRuntimeMode",
    ipcChannel: "desktop:getRuntimeMode",
  });
}

export async function getDesktopCarrotStoreRoot(): Promise<string | null> {
  const result = await invokeDesktopBridgeRequest<{ storeRoot: string }>({
    rpcMethod: "carrotGetStoreRoot",
    ipcChannel: "carrot:getStoreRoot",
  });
  return result?.storeRoot ?? null;
}

export async function listDesktopCarrots(): Promise<
  DesktopCarrotListEntry[] | null
> {
  const result = await invokeDesktopBridgeRequest<{
    carrots: DesktopCarrotListEntry[];
  }>({
    rpcMethod: "carrotList",
    ipcChannel: "carrot:list",
  });
  return result?.carrots ?? null;
}

export async function getDesktopCarrotStoreSnapshot(): Promise<DesktopCarrotStoreSnapshot | null> {
  return invokeDesktopBridgeRequest<DesktopCarrotStoreSnapshot>({
    rpcMethod: "carrotGetStoreSnapshot",
    ipcChannel: "carrot:getStoreSnapshot",
  });
}

export async function getDesktopCarrot(
  id: string,
): Promise<DesktopInstalledCarrotSnapshot | null> {
  return invokeDesktopBridgeRequest<DesktopInstalledCarrotSnapshot>({
    rpcMethod: "carrotGet",
    ipcChannel: "carrot:get",
    params: { id },
  });
}

export async function installDesktopCarrotFromDirectory(options: {
  sourceDir: string;
  devMode?: boolean;
  permissionsGranted?: DesktopCarrotPermissionGrant;
}): Promise<DesktopInstalledCarrotSnapshot | null> {
  return invokeDesktopBridgeRequest<DesktopInstalledCarrotSnapshot>({
    rpcMethod: "carrotInstallFromDirectory",
    ipcChannel: "carrot:installFromDirectory",
    params: options,
  });
}

export async function uninstallDesktopCarrot(id: string): Promise<{
  removed: boolean;
  carrot: DesktopCarrotListEntry | null;
} | null> {
  return invokeDesktopBridgeRequest<{
    removed: boolean;
    carrot: DesktopCarrotListEntry | null;
  }>({
    rpcMethod: "carrotUninstall",
    ipcChannel: "carrot:uninstall",
    params: { id },
  });
}

export async function startDesktopCarrotWorker(
  id: string,
): Promise<DesktopCarrotWorkerStatus | null> {
  return invokeDesktopBridgeRequest<DesktopCarrotWorkerStatus>({
    rpcMethod: "carrotStartWorker",
    ipcChannel: "carrot:startWorker",
    params: { id },
  });
}

export async function stopDesktopCarrotWorker(
  id: string,
): Promise<DesktopCarrotWorkerStatus | null> {
  return invokeDesktopBridgeRequest<DesktopCarrotWorkerStatus>({
    rpcMethod: "carrotStopWorker",
    ipcChannel: "carrot:stopWorker",
    params: { id },
  });
}

export async function getDesktopCarrotWorkerStatus(
  id: string,
): Promise<DesktopCarrotWorkerStatus | null> {
  return invokeDesktopBridgeRequest<DesktopCarrotWorkerStatus>({
    rpcMethod: "carrotGetWorkerStatus",
    ipcChannel: "carrot:getWorkerStatus",
    params: { id },
  });
}

export async function listDesktopCarrotWorkerStatuses(): Promise<
  DesktopCarrotWorkerStatus[] | null
> {
  const result = await invokeDesktopBridgeRequest<{
    workers: DesktopCarrotWorkerStatus[];
  }>({
    rpcMethod: "carrotListWorkerStatuses",
    ipcChannel: "carrot:listWorkerStatuses",
  });
  return result?.workers ?? null;
}

export async function getDesktopCarrotLogs(
  id: string,
  maxBytes?: number,
): Promise<DesktopCarrotLogsSnapshot | null> {
  return invokeDesktopBridgeRequest<DesktopCarrotLogsSnapshot>({
    rpcMethod: "carrotGetLogs",
    ipcChannel: "carrot:getLogs",
    params: { id, ...(maxBytes === undefined ? {} : { maxBytes }) },
  });
}

export function subscribeDesktopBridgeEvent(options: {
  rpcMessage: string;
  ipcChannel: string;
  listener: ElectrobunMessageListener;
}): () => void {
  const rpc = getElectrobunRendererRpc();
  if (rpc) {
    rpc.onMessage(options.rpcMessage, options.listener);
    return () => {
      rpc.offMessage(options.rpcMessage, options.listener);
    };
  }

  return () => {};
}
