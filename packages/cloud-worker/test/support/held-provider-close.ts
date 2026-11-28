// spec/cloud/services/speechRelay.md, "A provider link that closes while idle is opened again when it is next needed, and one that closes under an unfinished utterance is an outage"
import type { Socket } from "effect/socket";

type SocketOptions = string | string[] | Socket.WebSocketConstructorOptions;
type HeaderedSocket = new (url: string | URL, options?: SocketOptions) => WebSocket;

export function holdFirstTtsClose(fakeOrigin: string) {
  const provider = new URL("/speech/realtime/tts/websocket", fakeOrigin.replace(/^http/, "ws")).href;
  const NativeSocket = globalThis.WebSocket;
  const Base = NativeSocket as unknown as HeaderedSocket;
  const message = Promise.withResolvers<unknown>();
  const close = Promise.withResolvers<number>();
  const staleWrite = Promise.withResolvers<void>();
  const held: Event[] = [];
  let tracked: WebSocket | undefined;
  let holding = false;
  let watchingWrite = false;

  function observeClosedWrite(socket: WebSocket, state: number) {
    if (socket === tracked && watchingWrite && state === NativeSocket.CLOSED) staleWrite.resolve();
  }

  function track(socket: WebSocket) {
    tracked = socket;
    socket.addEventListener("message", (event) => {
      if (!holding) return;
      event.stopImmediatePropagation();
      const data: unknown = event.data;
      held.push(new MessageEvent<unknown>("message", { data }));
      message.resolve(data);
    });
    socket.addEventListener("close", (event) => {
      if (!holding) return;
      event.stopImmediatePropagation();
      const { code, reason, wasClean } = event;
      held.push(new CloseEvent("close", { code, reason, wasClean }));
      close.resolve(code);
    });
  }

  class ControlledSocket extends Base {
    constructor(url: string | URL, options?: SocketOptions) {
      super(url, options);
      if (tracked === undefined && new URL(url).href === provider) track(this);
    }

    override get readyState(): number {
      const state = super.readyState;
      observeClosedWrite(this, state);
      return state;
    }

    override send(...args: Parameters<WebSocket["send"]>): void {
      observeClosedWrite(this, super.readyState);
      super.send(...args);
    }
  }

  globalThis.WebSocket = ControlledSocket as unknown as typeof WebSocket;

  function release() {
    holding = false;
    watchingWrite = false;
    for (const event of held.splice(0)) tracked?.dispatchEvent(event);
  }

  return {
    hold: () => { holding = true; },
    message: message.promise,
    closed: close.promise,
    watchStaleWrite: () => { watchingWrite = true; },
    staleWrite: staleWrite.promise,
    release,
    restore: () => {
      release();
      globalThis.WebSocket = NativeSocket;
    },
  };
}
