/** Live, targeted renderer delivery over the existing private resident event feed. */
import type { IAgentRuntime } from "@elizaos/core";

type Renderer = {
  hostKey: object;
  close: () => void;
  send: (frame: object) => boolean;
  ended: Set<() => void>;
};
const nativeHosts = new WeakMap<IAgentRuntime, object>();
export function bindNativeViewHost(
  runtime: IAgentRuntime,
  hostKey: object,
): () => void {
  if (nativeHosts.has(runtime))
    throw Error("Native runtime already has an owning view host");
  nativeHosts.set(runtime, hostKey);
  return () => {
    if (nativeHosts.get(runtime) !== hostKey) return;
    nativeHosts.delete(runtime);
    for (const renderer of clients.get(runtime)?.values() ?? [])
      if (renderer.hostKey === hostKey) renderer.close();
  };
}
const clients = new WeakMap<IAgentRuntime, Map<string, Renderer>>();
export function registerNativeViewRenderer(
  runtime: IAgentRuntime,
  clientId: string,
  send: Renderer["send"],
): () => void {
  const stopSignal = runtime.getStopSignal?.();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId) || stopSignal?.aborted)
    throw Error("Invalid native renderer binding");
  const hostKey = nativeHosts.get(runtime);
  if (!hostKey) throw Error("Native renderer has no owning API host");
  let peers = clients.get(runtime);
  if (!peers) {
    peers = new Map();
    clients.set(runtime, peers);
  }
  if (peers.has(clientId)) throw Error("Native renderer is already subscribed");
  const renderer: Renderer = {
    hostKey,
    close: () => close(),
    send,
    ended: new Set(),
  };
  peers.set(clientId, renderer);
  const close = () => {
    if (peers.get(clientId) !== renderer) return;
    peers.delete(clientId);
    stopSignal?.removeEventListener("abort", close);
    for (const end of renderer.ended) end();
    renderer.ended.clear();
  };
  stopSignal?.addEventListener("abort", close, { once: true });
  // The signal may stop between the initial check and listener admission.
  if (stopSignal?.aborted) close();
  return close;
}
export function hasNativeViewRenderer(
  runtime: IAgentRuntime,
  hostKey: object,
  clientId: string,
): boolean {
  return clients.get(runtime)?.get(clientId)?.hostKey === hostKey;
}
export function sendNativeViewFrame(
  runtime: IAgentRuntime,
  hostKey: object,
  clientId: string,
  frame: object,
): number {
  const renderer = clients.get(runtime)?.get(clientId);
  return renderer?.hostKey === hostKey && renderer.send(frame) === true ? 1 : 0;
}
export function onNativeViewDisconnect(
  runtime: IAgentRuntime,
  clientId: string,
  ended: () => void,
): () => void {
  const renderer = clients.get(runtime)?.get(clientId);
  if (!renderer) return () => {};
  renderer.ended.add(ended);
  return () => renderer.ended.delete(ended);
}
