export interface BridgeTransport {
  on<T>(channel: string, handler: (payload: T) => void): () => void;
  send<TIn, TOut>(channel: string, payload: TIn): Promise<TOut>;
}

declare global {
  interface Window {
    __elizaLinuxBridge?: unknown;
  }
}

function isBridgeTransport(value: unknown): value is BridgeTransport {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.on === "function" && typeof candidate.send === "function"
  );
}

export function getBridgeTransport(): BridgeTransport | null {
  if (typeof window === "undefined") return null;
  const candidate = window.__elizaLinuxBridge;
  if (!candidate) return null;
  if (!isBridgeTransport(candidate)) return null;
  return candidate;
}
