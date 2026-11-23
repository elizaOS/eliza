// spec/cloud/services/speechRelay.md, "Story: Speak the relay protocol on one socket"
import type { Socket } from "effect/socket"

type HeaderedWebSocket = new (url: string, options?: Socket.WebSocketConstructorOptions) => globalThis.WebSocket

export function headerWebSocket(url: string, options?: Socket.WebSocketConstructorOptions): globalThis.WebSocket {
  return new (globalThis.WebSocket as unknown as HeaderedWebSocket)(url, options)
}
