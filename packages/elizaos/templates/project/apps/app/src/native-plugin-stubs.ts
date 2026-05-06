export const Agent = {
  async getStatus(): Promise<{ status: string }> {
    return { status: "unavailable" };
  },
};

type ListenerHandle = {
  remove(): void | Promise<void>;
};

type DesktopEventPayload<TEvent extends string> =
  TEvent extends "shortcutPressed"
    ? { id: string }
    : TEvent extends "trayMenuClick"
      ? { itemId: string; checked?: boolean }
      : unknown;

export const Desktop = {
  async getVersion(): Promise<{ runtime: string }> {
    return { runtime: "N/A" };
  },
  async registerShortcut(_options: {
    id: string;
    accelerator: string;
  }): Promise<void> {},
  async addListener<TEvent extends string>(
    _eventName: TEvent,
    _listener: (event: DesktopEventPayload<TEvent>) => void,
  ): Promise<ListenerHandle> {
    return { remove() {} };
  },
  async setTrayMenu(_options: { menu: readonly unknown[] }): Promise<void> {},
};

export interface DeviceBridgeClient {
  stop(): void;
}

export type DeviceBridgeClientState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface StartDeviceBridgeClientOptions {
  agentUrl: string;
  pairingToken?: string;
  deviceId?: string;
  onStateChange?: (state: DeviceBridgeClientState, detail?: string) => void;
}

export function startDeviceBridgeClient(
  _options: StartDeviceBridgeClientOptions,
): DeviceBridgeClient {
  return { stop() {} };
}
