// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"; spec/cloud/services/speechRelay.md, "Story: Speak the relay protocol on one socket"
type CloudSocket = WebSocket & { accept(): void }
type Upgraded = Response & { readonly webSocket?: CloudSocket | null }

declare const WebSocketPair: new () => { 0: CloudSocket; 1: CloudSocket }

export async function dialSocket(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<WebSocket> {
  const upgraded: Upgraded = await fetch(url.replace(/^ws(s?):/, "http$1:"), { headers: { ...headers, Upgrade: "websocket" }, redirect: "manual", signal })
  const socket = upgraded.webSocket
  if (upgraded.status !== 101 || !socket) throw new Error(`the socket upgrade answered ${upgraded.status}`)
  socket.accept()
  return socket
}

/** @throws {never} */
export function socketPair(): { readonly accept: () => WebSocket; readonly answer: Response } {
  const pair = new WebSocketPair()
  const server = pair[1]
  return {
    accept: () => {
      server.accept()
      return server
    },
    answer: new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
  }
}
