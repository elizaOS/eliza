export interface ElectrobunRendererRpc {
  request?: Record<string, (params?: unknown) => Promise<unknown> | unknown>;
  onMessage: (event: string, listener: (payload: unknown) => void) => void;
  offMessage: (event: string, listener: (payload: unknown) => void) => void;
}

interface RuntimeWindow extends Window {
  __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
  __electrobunWindowId?: number;
  __electrobunWebviewId?: number;
}

function getRuntimeWindow(): RuntimeWindow | null {
  const g = globalThis as typeof globalThis & { window?: RuntimeWindow };
  if (typeof g.window === "undefined") {
    return null;
  }

  return g.window;
}

export function getElectrobunRendererRpc(): ElectrobunRendererRpc | undefined {
  const runtimeWindow = getRuntimeWindow();
  return runtimeWindow?.__ELIZA_ELECTROBUN_RPC__ ?? undefined;
}

function hasElectrobunRendererBridge(): boolean {
  const rpc = getElectrobunRendererRpc();
  return Boolean(
    rpc &&
      typeof rpc.onMessage === "function" &&
      rpc.request &&
      typeof rpc.request === "object",
  );
}

export function isElectrobunRuntime(): boolean {
  const runtimeWindow = getRuntimeWindow();
  if (!runtimeWindow) {
    return false;
  }

  if (
    typeof runtimeWindow.__electrobunWindowId === "number" ||
    typeof runtimeWindow.__electrobunWebviewId === "number"
  ) {
    return true;
  }

  return hasElectrobunRendererBridge();
}

export function getBackendStartupTimeoutMs(): number {
  return isElectrobunRuntime() ? 180_000 : 30_000;
}

export async function invokeDesktopBridgeRequest<T = unknown>(options: {
  rpcMethod: string;
  ipcChannel?: string;
  params?: unknown;
}): Promise<T | null> {
  const request = getElectrobunRendererRpc()?.request?.[options.rpcMethod];
  if (!request) {
    return null;
  }

  return (await request(options.params)) as T;
}

export type DesktopBridgeTimeoutResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "timeout" }
  | { status: "rejected"; error: unknown };

/** Mirrors `packages/app-core/src/bridge/electrobun-rpc.ts` for Vitest alias. */
export async function invokeDesktopBridgeRequestWithTimeout<T>(options: {
  rpcMethod: string;
  ipcChannel?: string;
  params?: unknown;
  timeoutMs: number;
}): Promise<DesktopBridgeTimeoutResult<T>> {
  const request = getElectrobunRendererRpc()?.request?.[options.rpcMethod];
  if (!request) {
    return { status: "missing" };
  }

  const call = request(options.params) as Promise<T>;
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

export function subscribeDesktopBridgeEvent(options: {
  rpcMessage: string;
  listener: (payload: unknown) => void;
}): () => void {
  const rpc = getElectrobunRendererRpc();
  if (!rpc) {
    return () => {};
  }

  rpc.onMessage(options.rpcMessage, options.listener);
  return () => {
    rpc.offMessage(options.rpcMessage, options.listener);
  };
}

export function initializeCapacitorBridge(): void {}

export async function initializeStorageBridge(): Promise<void> {}

export async function scanProviderCredentials(): Promise<unknown[]> {
  return [];
}
