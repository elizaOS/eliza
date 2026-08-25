/**
 * Renderer→main RPC for the Electrobun desktop shell: request/message plumbing
 * and the typed bridge-request helpers other modules call. The seam between the
 * web renderer and the native host.
 */
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

export type DesktopSecureStoreKind =
  | "session.device_auth"
  | "session.steward_token"
  | "runtime.active_server"
  | "runtime.agent_profiles";

export type DesktopSecureStoreResult =
  | { ok: true; value?: string; deleted?: boolean }
  | {
      ok: false;
      reason: "not_found" | "denied" | "unavailable" | "error";
      message?: string;
    };

export async function desktopSecureStoreGet(
  kind: DesktopSecureStoreKind,
): Promise<DesktopSecureStoreResult | null> {
  return invokeDesktopBridgeRequest<DesktopSecureStoreResult>({
    rpcMethod: "secureStoreGet",
    ipcChannel: "secureStore:get",
    params: { kind },
  });
}

export async function desktopSecureStoreSet(
  kind: DesktopSecureStoreKind,
  value: string,
): Promise<DesktopSecureStoreResult | null> {
  return invokeDesktopBridgeRequest<DesktopSecureStoreResult>({
    rpcMethod: "secureStoreSet",
    ipcChannel: "secureStore:set",
    params: { kind, value },
  });
}

export async function desktopSecureStoreDelete(
  kind: DesktopSecureStoreKind,
): Promise<DesktopSecureStoreResult | null> {
  return invokeDesktopBridgeRequest<DesktopSecureStoreResult>({
    rpcMethod: "secureStoreDelete",
    ipcChannel: "secureStore:delete",
    params: { kind },
  });
}

export interface DesktopRuntimeModeInfo {
  mode: "local" | "external" | "disabled";
  externalApiBase?: string | null;
  externalApiSource?: string | null;
}

export type DynamicViewPlacement =
  | "canvas"
  | "floating"
  | "panel"
  | "chat-inline"
  | "tray"
  | "debug";

export type DynamicViewSource = "agent" | "plugin" | "system" | "developer";

export interface DynamicViewManifest {
  id: string;
  title: string;
  description?: string;
  source: DynamicViewSource;
  entrypoint: string;
  placement: DynamicViewPlacement;
  permissions?: string[];
  metadata?: Record<string, unknown>;
}

export async function registerDynamicView(
  manifest: DynamicViewManifest,
  options?: { update?: boolean },
): Promise<DynamicViewManifest | null> {
  return invokeDesktopBridgeRequest<DynamicViewManifest>({
    rpcMethod: "dynamicViewRegister",
    ipcChannel: "dynamic-view:register",
    params: { manifest, update: options?.update === true },
  });
}

export async function unregisterDynamicView(
  viewId: string,
): Promise<{ removed: boolean } | null> {
  return invokeDesktopBridgeRequest<{ removed: boolean }>({
    rpcMethod: "dynamicViewUnregister",
    ipcChannel: "dynamic-view:unregister",
    params: { viewId },
  });
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
    params: { context: "first-run" },
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

export async function desktopOpenPath(path: string): Promise<void> {
  await invokeDesktopBridgeRequest<undefined>({
    rpcMethod: "desktopOpenPath",
    ipcChannel: "desktop:openPath",
    params: { path },
  });
}

/**
 * Open a view as its own desktop window (#9953 Phase 3). Backs "show a view"
 * from the chromeless bottom-bar shell, where there is no full-app tab system to
 * host the view inline. Returns the managed-window id, or null when the bridge
 * is unavailable (non-desktop).
 */
export async function openDesktopAppWindow(options: {
  slug?: string;
  title: string;
  path: string;
  alwaysOnTop?: boolean;
}): Promise<{ id: string } | null> {
  return invokeDesktopBridgeRequest<{ id: string }>({
    rpcMethod: "desktopOpenAppWindow",
    ipcChannel: "desktop:openAppWindow",
    params: {
      slug: options.slug,
      title: options.title,
      path: options.path,
      alwaysOnTop: options.alwaysOnTop === true,
    },
  });
}

/** Route path for the on-demand launcher/dashboard window. */
export const DESKTOP_LAUNCHER_WINDOW_PATH = "/views";

/**
 * Summon the launcher (the views/app springboard) as its own desktop window
 * (#9953 Phase 3). The bottom bar is the resting surface; the launcher is an
 * on-demand window, not the resting surface.
 */
export async function openDesktopLauncherWindow(): Promise<{
  id: string;
} | null> {
  return openDesktopAppWindow({
    slug: "launcher",
    title: "Launcher",
    path: DESKTOP_LAUNCHER_WINDOW_PATH,
  });
}

export type DesktopBottomBarSurfaceState =
  | "CLOSED"
  | "INPUT"
  | "INPUT_MENU"
  | "OPEN_UNDER_HALF"
  | "OPEN_HALF_OR_OVER"
  | "MAXIMIZED";

export async function setDesktopBottomBarSurfaceState(
  state: DesktopBottomBarSurfaceState,
): Promise<void> {
  await invokeDesktopBridgeRequest<undefined>({
    rpcMethod: "desktopSetBottomBarSurfaceState",
    ipcChannel: "desktop:setBottomBarSurfaceState",
    params: { state },
  });
}

export async function desktopShowItemInFolder(path: string): Promise<void> {
  await invokeDesktopBridgeRequest<undefined>({
    rpcMethod: "desktopShowItemInFolder",
    ipcChannel: "desktop:showItemInFolder",
    params: { path },
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
