export interface BridgeTransport {
  on<T>(channel: string, handler: (payload: T) => void): () => void;
  send<TIn, TOut>(channel: string, payload: TIn): Promise<TOut>;
}

declare global {
  interface Window {
    __elizaAndroidBridge?: unknown;
    ElizaAndroidSystemBridgeNative?: unknown;
  }
}

function isBridgeTransport(value: unknown): value is BridgeTransport {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.on === "function" && typeof candidate.send === "function"
  );
}

interface NativeAndroidSystemBridge {
  subscribe(channel: string): string;
  unsubscribe(id: string): void;
  snapshot(channel: string): string;
  send(channel: string, payloadJson: string): string;
}

function isNativeAndroidSystemBridge(
  value: unknown,
): value is NativeAndroidSystemBridge {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.subscribe === "function" &&
    typeof candidate.unsubscribe === "function" &&
    typeof candidate.snapshot === "function" &&
    typeof candidate.send === "function"
  );
}

function parseNativeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function bridgeTransportFromNative(
  native: NativeAndroidSystemBridge,
): BridgeTransport {
  return {
    on: <T>(channel: string, handler: (payload: T) => void) => {
      const id = native.subscribe(channel);
      handler(parseNativeJson<T>(native.snapshot(channel)));
      return () => {
        native.unsubscribe(id);
      };
    },
    send: async <TIn, TOut>(channel: string, payload: TIn) => {
      return parseNativeJson<TOut>(native.send(channel, JSON.stringify(payload)));
    },
  };
}

export function getBridgeTransport(): BridgeTransport | null {
  if (typeof window === "undefined") return null;
  const candidate = window.__elizaAndroidBridge;
  if (isBridgeTransport(candidate)) return candidate;
  const native = window.ElizaAndroidSystemBridgeNative;
  if (!isNativeAndroidSystemBridge(native)) return null;
  const transport = bridgeTransportFromNative(native);
  window.__elizaAndroidBridge = transport;
  return transport;
}
