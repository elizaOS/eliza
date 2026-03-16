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
  __MILADY_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
}

function getDesktopBridgeWindow(): DesktopBridgeWindow | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window as DesktopBridgeWindow;
}

export function getElectrobunRendererRpc(): ElectrobunRendererRpc | undefined {
  return getDesktopBridgeWindow()?.__MILADY_ELECTROBUN_RPC__;
}

export async function invokeDesktopBridgeRequest<T>(options: {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
}): Promise<T | null> {
  const rpc = getElectrobunRendererRpc();
  const request = rpc?.request?.[options.rpcMethod];
  if (request) {
    return (await request(options.params)) as T;
  }

  return null;
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
