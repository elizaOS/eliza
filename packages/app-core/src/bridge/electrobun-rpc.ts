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
