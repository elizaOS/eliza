/**
 * REAL WebSocket wire round-trip coverage for the view interact protocol (#10722).
 *
 * Both ends of the interact protocol are unit-tested separately — the HTTP
 * route in packages/agent/src/api/views-routes.interact-coverage.test.ts and
 * the client dispatch in packages/ui DynamicViewLoader/view-interact-registry
 * tests — but nothing connected them over a real socket. This suite boots the
 * REAL AgentRuntime + the REAL HTTP+WS server ({@link startLiveRuntimeServer})
 * and drives the full wire:
 *
 *   POST /api/views/:id/interact
 *     → server registers the pending slot (pending-request-map.ts)
 *     → server broadcasts `view:interact` over the real WebSocket (/ws)
 *     → a connected client replies `view:interact:result`
 *     → the pending HTTP request resolves with the client's payload.
 *
 * Wire behaviors covered (the exact gaps named in #10722):
 *   - happy round-trip: broadcast shape + HTTP result passthrough
 *   - 504 when a client is connected but never responds
 *   - 504 when NO client is connected at all
 *   - multi-tab: every connected socket receives the broadcast; the first
 *     result wins; a second result for the same requestId is a no-op
 *   - a late result after the 504 already fired is a no-op (server healthy)
 *   - malformed / unknown-requestId result frames are ignored
 *   - the HTTP fallback POST /api/views/interact-result resolves the slot
 *
 * Message shapes grounded in:
 *   packages/agent/src/api/views-routes.ts (interact route + interact-result)
 *   packages/agent/src/api/server.ts       (WS upgrade at /ws + result handler)
 *   packages/agent/src/api/pending-request-map.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { req } from "../helpers/http.ts";
import {
  type RuntimeHarness,
  startLiveRuntimeServer,
} from "../helpers/live-runtime-server.ts";

type WsMessage = Record<string, unknown>;

/**
 * Minimal real-socket client speaking the exact dashboard wire protocol.
 * Uses the Node global WebSocket (Node >= 22) — no browser, no mocks.
 */
class TestWsClient {
  readonly messages: WsMessage[] = [];
  private readonly waiters: Array<{
    predicate: (msg: WsMessage) => boolean;
    resolve: (msg: WsMessage) => void;
  }> = [];

  private constructor(private readonly ws: WebSocket) {}

  static async connect(port: number, label: string): Promise<TestWsClient> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?clientId=${encodeURIComponent(label)}`,
    );
    const client = new TestWsClient(ws);
    ws.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      const msg = parsed as WsMessage;
      client.messages.push(msg);
      for (let i = client.waiters.length - 1; i >= 0; i--) {
        const waiter = client.waiters[i];
        if (waiter.predicate(msg)) {
          client.waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`WS client "${label}" failed to open in 15s`)),
        15_000,
      );
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`WS client "${label}" errored during connect`));
      });
    });
    return client;
  }

  /** Resolve with the first message (past or future) matching the predicate. */
  waitFor(
    predicate: (msg: WsMessage) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<WsMessage> {
    const already = this.messages.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise<WsMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${what}`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  send(payload: WsMessage): void {
    this.ws.send(JSON.stringify(payload));
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      this.ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }
}

function isInteractBroadcast(msg: WsMessage): boolean {
  return msg.type === "view:interact";
}

describe("view interact WS wire round-trip", () => {
  let harness: RuntimeHarness | null = null;
  const openClients: TestWsClient[] = [];

  beforeAll(async () => {
    harness = await startLiveRuntimeServer({
      tempPrefix: "views-interact-ws-",
    });
  }, 120_000);

  afterAll(async () => {
    for (const client of openClients.splice(0)) {
      await client.close();
    }
    await harness?.close();
  });

  function port(): number {
    if (!harness) throw new Error("Live runtime harness was not started");
    return harness.port;
  }

  async function connect(label: string): Promise<TestWsClient> {
    const client = await TestWsClient.connect(port(), label);
    openClients.push(client);
    return client;
  }

  async function disconnectAll(): Promise<void> {
    for (const client of openClients.splice(0)) {
      await client.close();
    }
  }

  /** One healthy round-trip; used to prove the server survived a failure case. */
  async function healthyRoundTrip(
    client: TestWsClient,
    marker: string,
  ): Promise<void> {
    const interact = req(port(), "POST", "/api/views/settings/interact", {
      capability: "get-state",
      params: { marker },
      timeoutMs: 10_000,
    });
    const broadcast = await client.waitFor(
      (msg) =>
        isInteractBroadcast(msg) &&
        (msg.params as Record<string, unknown> | undefined)?.marker === marker,
      15_000,
      `view:interact broadcast (marker=${marker})`,
    );
    client.send({
      type: "view:interact:result",
      requestId: broadcast.requestId,
      success: true,
      result: { marker },
    });
    const { status, data } = await interact;
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect((data.result as Record<string, unknown>).marker).toBe(marker);
  }

  it("completes the full wire: POST interact → WS broadcast → client result → HTTP response", {
    timeout: 60_000,
  }, async () => {
    const client = await connect("tab-happy");

    const interact = req(port(), "POST", "/api/views/settings/interact", {
      capability: "get-state",
      params: { probe: "value-123" },
      timeoutMs: 10_000,
    });

    // The REAL broadcast the dashboard would receive, over the real socket.
    const broadcast = await client.waitFor(
      isInteractBroadcast,
      15_000,
      "view:interact broadcast",
    );
    expect(broadcast.viewId).toBe("settings");
    expect(broadcast.viewType).toBe("gui");
    expect(broadcast.capability).toBe("get-state");
    expect(broadcast.params).toEqual({ probe: "value-123" });
    expect(typeof broadcast.requestId).toBe("string");
    expect(String(broadcast.requestId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    client.send({
      type: "view:interact:result",
      requestId: broadcast.requestId,
      success: true,
      result: { answered: "by-client", echo: broadcast.params },
    });

    const { status, data } = await interact;
    expect(status).toBe(200);
    expect(data.requestId).toBe(broadcast.requestId);
    expect(data.success).toBe(true);
    expect(data.result).toEqual({
      answered: "by-client",
      echo: { probe: "value-123" },
    });

    await disconnectAll();
  });

  it("returns 504 when a connected client never responds, and a late result is a no-op", {
    timeout: 60_000,
  }, async () => {
    const client = await connect("tab-silent");

    const interact = req(port(), "POST", "/api/views/settings/interact", {
      capability: "get-state",
      params: { case: "silent" },
      timeoutMs: 500,
    });
    const broadcast = await client.waitFor(
      (msg) =>
        isInteractBroadcast(msg) &&
        (msg.params as Record<string, unknown> | undefined)?.case === "silent",
      15_000,
      "view:interact broadcast (silent case)",
    );

    // Deliberately do NOT respond before the server-side timeout fires.
    const { status, data } = await interact;
    expect(status).toBe(504);
    expect(String(data.error)).toContain(
      'did not respond to capability "get-state" within 500ms',
    );

    // The dashboard tab wakes up late; the pending slot is already gone.
    // resolve() on an unknown requestId must be a no-op, not a crash.
    client.send({
      type: "view:interact:result",
      requestId: broadcast.requestId,
      success: true,
      result: { tooLate: true },
    });

    await healthyRoundTrip(client, "after-late-result");
    await disconnectAll();
  });

  it("returns 504 when no client is connected at all", {
    timeout: 60_000,
  }, async () => {
    await disconnectAll();

    const { status, data } = await req(
      port(),
      "POST",
      "/api/views/settings/interact",
      {
        capability: "get-state",
        params: { case: "no-client" },
        timeoutMs: 400,
      },
    );
    expect(status).toBe(504);
    expect(String(data.error)).toContain(
      'View "settings" did not respond to capability "get-state" within 400ms',
    );
  });

  it("broadcasts to every connected tab; the first result wins and the second is ignored", {
    timeout: 60_000,
  }, async () => {
    const tabA = await connect("tab-a");
    const tabB = await connect("tab-b");

    const interact = req(port(), "POST", "/api/views/settings/interact", {
      capability: "get-state",
      params: { case: "multi-tab" },
      timeoutMs: 10_000,
    });

    const isMultiTab = (msg: WsMessage) =>
      isInteractBroadcast(msg) &&
      (msg.params as Record<string, unknown> | undefined)?.case === "multi-tab";
    const [broadcastA, broadcastB] = await Promise.all([
      tabA.waitFor(isMultiTab, 15_000, "view:interact on tab A"),
      tabB.waitFor(isMultiTab, 15_000, "view:interact on tab B"),
    ]);
    // The same request really reached both sockets.
    expect(broadcastA.requestId).toBe(broadcastB.requestId);

    tabA.send({
      type: "view:interact:result",
      requestId: broadcastA.requestId,
      success: true,
      result: { from: "A" },
    });

    const { status, data } = await interact;
    expect(status).toBe(200);
    expect((data.result as Record<string, unknown>).from).toBe("A");

    // Tab B answers the already-resolved request — must be a no-op.
    tabB.send({
      type: "view:interact:result",
      requestId: broadcastB.requestId,
      success: true,
      result: { from: "B" },
    });

    await healthyRoundTrip(tabA, "after-duplicate-result");
    await disconnectAll();
  });

  it("ignores malformed and unknown-requestId result frames without corrupting the wire", {
    timeout: 60_000,
  }, async () => {
    const client = await connect("tab-adversarial");

    client.sendRaw("not-json{");
    client.send({ type: "view:interact:result" }); // missing requestId
    client.send({ type: "view:interact:result", requestId: 12345 as never });
    client.send({
      type: "view:interact:result",
      requestId: "00000000-0000-0000-0000-000000000000",
      success: true,
      result: { ghost: true },
    });
    client.send({ type: "definitely-not-a-real-type", requestId: "x" });

    await healthyRoundTrip(client, "after-adversarial-frames");
    await disconnectAll();
  });

  it("resolves the pending slot via the HTTP fallback POST /api/views/interact-result", {
    timeout: 60_000,
  }, async () => {
    const client = await connect("tab-http-fallback");

    const interact = req(port(), "POST", "/api/views/settings/interact", {
      capability: "get-state",
      params: { case: "http-fallback" },
      timeoutMs: 10_000,
    });
    const broadcast = await client.waitFor(
      (msg) =>
        isInteractBroadcast(msg) &&
        (msg.params as Record<string, unknown> | undefined)?.case ===
          "http-fallback",
      15_000,
      "view:interact broadcast (http fallback case)",
    );

    // Answer over HTTP instead of the socket — the documented fallback for
    // clients whose WS send path is unavailable.
    const resultPost = await req(port(), "POST", "/api/views/interact-result", {
      requestId: broadcast.requestId,
      success: true,
      result: { via: "http" },
    });
    expect(resultPost.status).toBe(200);
    expect(resultPost.data.ok).toBe(true);

    const { status, data } = await interact;
    expect(status).toBe(200);
    expect((data.result as Record<string, unknown>).via).toBe("http");

    await disconnectAll();
  });
});
