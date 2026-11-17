// spec/cloud/index.md, "Story: Use a cloud speech session"
export type CloudSocket = WebSocket & { accept(): void }
type Upgrade = Response & { webSocket?: CloudSocket }

declare const WebSocketPair: new () => { 0: CloudSocket; 1: CloudSocket }

export function speechInternalRequest(path: string, init: Request | RequestInit) {
  return new Request("https://speech.internal/" + path, init)
}

export const voiceNow = () => Date.now()

export function acceptSpeechSocket() {
  const pair = new WebSocketPair()
  const responseOptions = { status: 101, webSocket: pair[0] }
  const response = new Response(null, responseOptions)
  pair[1].accept()
  pair[1].binaryType = "arraybuffer"
  return { relay: pair[1], response }
}

export async function openSpeechProvider(url: URL, key: string, version: string, signal: AbortSignal) {
  const deadline = new AbortController()
  const stop = speechTimer(() => deadline.abort(), 8000)
  try {
    const upgrade: Upgrade = await fetch(url, {
      headers: { Upgrade: "websocket", "X-API-Key": key, "Cartesia-Version": version }, redirect: "manual",
      signal: AbortSignal.any([signal, deadline.signal])
    })
    const socket = upgrade.webSocket
    if (upgrade.status !== 101 || !socket) throw new Error("Provider upgrade failed")
    socket.accept()
    return socket
  } finally {
    stop()
  }
}

export function drainSpeechInput(socket: CloudSocket, timeoutMs: number): Promise<boolean> {
  if (socket.readyState !== 1) return Promise.resolve(false)
  return new Promise((resolve) => {
    let finished = false
    const stop = speechTimer(() => complete(false), timeoutMs)
    function complete(clean: boolean) {
      if (finished) return
      finished = true
      stop()
      socket.removeEventListener("close", onClose)
      socket.removeEventListener("error", onError)
      resolve(clean)
    }
    const onClose = (event: CloseEvent) => complete(event.code === 1000 && (event.wasClean || event.reason === "Close message"))
    const onError = () => complete(false)
    socket.addEventListener("close", onClose)
    socket.addEventListener("error", onError)
    try {
      socket.send(JSON.stringify({ type: "close" }))
    } catch {
      complete(false)
    }
  })
}

export function speechTimer(action: () => void | Promise<void>, ms: number) {
  const handle = setTimeout(() => { void Promise.resolve().then(action).catch(() => undefined) }, ms)
  return () => clearTimeout(handle)
}

export function speechDeadline(ms: number) {
  let cancel = () => {}
  const elapsed = new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => resolve(true), ms)
    cancel = () => { clearTimeout(deadline); resolve(false) }
  })
  return { elapsed, cancel }
}
