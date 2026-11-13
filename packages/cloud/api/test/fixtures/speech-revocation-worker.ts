import { subscribeSpeechRevocation } from "../../src/speech-revocation-subscription";

export class Fence {
  private socket?: WebSocket;
  async fetch(request: Request): Promise<Response> {
    const mode = new URL(request.url).pathname;
    if (mode === "/close") {
      this.socket?.close(1008, "Speech identity revoked");
      return new Response(null);
    }
    if (mode === "/slow")
      await new Promise((resolve) => setTimeout(resolve, 3200));
    const pair = new WebSocketPair();
    this.socket = pair[1];
    this.socket.accept();
    if (mode !== "/no-ready") this.socket.send("ready");
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

export default {
  async fetch(request: Request, env: { FENCE: DurableObjectNamespace }) {
    const mode = new URL(request.url).pathname;
    const fence = env.FENCE.getByName(mode);
    let signal: AbortSignal | undefined;
    let revoked = false;
    let resolveRevoked!: () => void;
    const lost = new Promise<void>((resolve) => {
      resolveRevoked = resolve;
    });
    const started = Date.now();
    const binding = {
      getByName: () => ({
        fetch: (_url: string, init: RequestInit) => {
          signal = init.signal ?? undefined;
          return fence.fetch(`https://fence${mode}`, init);
        },
      }),
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await subscribeSpeechRevocation(
        { INFERENCE_ADMISSION_GATES: binding } as never,
        {
          user: { organization_id: "test-org" },
          credential: { kind: "api_key" },
        } as never,
        Date.now() + 60000,
        () => {
          revoked = true;
          resolveRevoked();
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const healthy = { aborted: signal?.aborted, revoked };
      if (mode === "/unsubscribe") {
        unsubscribe();
        await new Promise((resolve) => setTimeout(resolve, 20));
      } else {
        await fence.fetch("https://fence/close");
        await Promise.race([
          lost,
          new Promise((_, reject) =>
            setTimeout(() => reject(Error("Lost fence did not revoke")), 1000),
          ),
        ]);
      }
      return Response.json({ connected: true, healthy, revoked });
    } catch {
      return Response.json({
        connected: false,
        aborted: signal?.aborted,
        elapsedMs: Date.now() - started,
      });
    } finally {
      unsubscribe?.();
    }
  },
};
