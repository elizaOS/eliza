export function initializeCapacitorBridge(): void;
export function initializeStorageBridge(): Promise<void>;
export function isElectrobunRuntime(): boolean;
export function subscribeDesktopBridgeEvent(options: {
  ipcChannel: string;
  listener: (payload: unknown) => void;
  rpcMessage: string;
}): (() => void) | undefined;
