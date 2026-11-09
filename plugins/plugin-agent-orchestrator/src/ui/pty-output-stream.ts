/**
 * Shared PTY output subscription for the terminal panes. Subscribes to live
 * output before fetching the buffered scrollback, holds live chunks until the
 * snapshot arrives, then applies snapshot plus held chunks. A WS reconnect
 * opens a new server socket with an empty subscription map, so it resubscribes
 * and replaces the output with a fresh snapshot.
 */
import { client } from "@elizaos/ui";

export interface PtyOutputStreamHandlers {
  /** Replace everything shown with this scrollback snapshot. */
  onSnapshot: (text: string) => void;
  /** Append live output. */
  onData: (text: string) => void;
}

/** Minimal client surface, so the sequence can be exercised without a socket. */
export interface PtyOutputStreamClient {
  getPtyBufferedOutput(sessionId: string): Promise<string>;
  subscribePtyOutput(sessionId: string): void;
  unsubscribePtyOutput(sessionId: string): void;
  onWsEvent(
    type: string,
    handler: (data: Record<string, unknown>) => void,
  ): () => void;
  onReconnect(listener: () => void): () => void;
}

/** Starts streaming `sessionId`; the returned function stops it. */
export function streamPtyOutput(
  sessionId: string,
  handlers: PtyOutputStreamHandlers,
  ptyClient: PtyOutputStreamClient = client,
): () => void {
  let disposed = false;
  let generation = 0;
  let held: string[] | null = null;

  const unbind = ptyClient.onWsEvent("pty-output", (data) => {
    if (disposed || data.sessionId !== sessionId) return;
    if (typeof data.data !== "string" || !data.data) return;
    if (held) held.push(data.data);
    else handlers.onData(data.data);
  });

  const load = async () => {
    const current = ++generation;
    held = [];
    let snapshot = "";
    try {
      snapshot = (await ptyClient.getPtyBufferedOutput(sessionId)) ?? "";
    } catch {
      // Session may have ended; show what arrives live.
    }
    if (disposed || current !== generation) return;
    const pending = (held ?? []).join("");
    held = null;
    handlers.onSnapshot(snapshot);
    const rest = pending.slice(overlapLength(snapshot, pending));
    if (rest) handlers.onData(rest);
  };

  ptyClient.subscribePtyOutput(sessionId);
  void load();

  const unbindReconnect = ptyClient.onReconnect(() => {
    if (disposed) return;
    ptyClient.subscribePtyOutput(sessionId);
    void load();
  });

  return () => {
    disposed = true;
    unbind();
    unbindReconnect();
    ptyClient.unsubscribePtyOutput(sessionId);
  };
}

/**
 * Length of the longest prefix of `live` that the snapshot already ends with.
 * The server sends no offsets, so this is a heuristic: output that repeats
 * exactly across the boundary can be dropped once.
 */
export function overlapLength(snapshot: string, live: string): number {
  for (let k = Math.min(snapshot.length, live.length); k > 0; k--) {
    if (snapshot.endsWith(live.slice(0, k))) return k;
  }
  return 0;
}
