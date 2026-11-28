// spec/cloud/services/speechRelay.md, "Story: Speak the relay protocol on one socket"
import type { Socket } from "effect/socket"

type HeaderedWebSocket = new (url: string, options?: Socket.WebSocketConstructorOptions) => globalThis.WebSocket

export function headerWebSocket(url: string, options?: Socket.WebSocketConstructorOptions): globalThis.WebSocket {
  return new (globalThis.WebSocket as unknown as HeaderedWebSocket)(url, options)
}

export class ClosedSocketWrite extends Error {}

export function guardProviderWebSocket(socket: WebSocket): Socket.WebSocketLike & Pick<WebSocket, "binaryType"> {
  return {
    get readyState() { return socket.readyState },
    get binaryType() { return socket.binaryType },
    set binaryType(value: BinaryType) {
      if ("binaryType" in socket) socket.binaryType = value
    },
    addEventListener: socket.addEventListener.bind(socket),
    removeEventListener: socket.removeEventListener.bind(socket),
    close: socket.close.bind(socket),
    send(frame) {
      const ready = socket.readyState
      if (ready === WebSocket.CLOSING || ready === WebSocket.CLOSED) throw new ClosedSocketWrite()
      socket.send(frame)
    }
  }
}
