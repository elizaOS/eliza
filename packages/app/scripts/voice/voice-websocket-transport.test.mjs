import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCartesiaInkRealtimeSession } from "@elizaos/host/voice/cartesia-ink";
import { CartesiaSonicTtsAdapter } from "@elizaos/host/voice/cartesia-sonic-tts";
import { attachVoiceWsHandler } from "@elizaos/host/voice/ws-handler";
import WebSocket, { WebSocketServer } from "ws";
import { adaptVoiceWebSocket } from "../../src/api/voice-websocket-transport.ts";

const hello = {
  t: "hello",
  token: "transport-test-token",
  protocol: 1,
  uplinkCodec: "pcm16",
  downlinkCodec: "pcm16",
  sampleRate: 16000,
};
const claims = {
  sessionId: "session",
  organizationId: "organization",
  userId: "owner",
  agentId: "agent",
  conversationId: "conversation",
};

async function fixture(t, onConnection) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", onConnection);
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return `ws://127.0.0.1:${server.address().port}`;
}
function message(socket) {
  return once(socket, "message").then(([data]) => JSON.parse(String(data)));
}
function bounded(promise) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("WebSocket regression timed out")),
        3000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}
function deps(buildSession) {
  return {
    requestedSessionId: claims.sessionId,
    verifyToken: async (token) => {
      assert.equal(token, hello.token);
      return {
        claims,
        jti: "ticket",
        expSeconds: Math.floor(Date.now() / 1000) + 120,
      };
    },
    buildSession,
  };
}

test("text hello and controls retain their kind while binary PCM remains exact", async (t) => {
  let resolveAudio, resolveBarge;
  const audio = new Promise((resolve) => {
    resolveAudio = resolve;
  });
  const barge = new Promise((resolve) => {
    resolveBarge = resolve;
  });
  const url = await fixture(t, (ws) =>
    attachVoiceWsHandler(
      adaptVoiceWebSocket(ws),
      deps(({ downlink }) => ({
        start: () =>
          downlink.sendControl({
            t: "ready",
            sessionId: "session",
            traceId: "trace",
          }),
        pushUplinkAudio: resolveAudio,
        bargeIn: resolveBarge,
        bye() {},
        sever() {},
      })),
    ),
  );
  const client = new WebSocket(url);
  t.after(() => client.terminate());
  await once(client, "open");
  const ready = message(client);
  client.send(JSON.stringify(hello));
  assert.equal((await bounded(ready)).t, "ready");
  const pcm = Buffer.from([0, 255, 123, 34, 116, 34, 0, 0]);
  client.send(pcm, { binary: true });
  assert.deepEqual(Buffer.from(await bounded(audio)), pcm);
  client.send(JSON.stringify({ t: "barge_in" }));
  await bounded(barge);
});

test("a binary frame containing valid hello JSON cannot authenticate", async (t) => {
  let started = false;
  const url = await fixture(t, (ws) =>
    attachVoiceWsHandler(
      adaptVoiceWebSocket(ws),
      deps(() => {
        started = true;
        throw new Error("Binary hello admitted");
      }),
    ),
  );
  const client = new WebSocket(url);
  t.after(() => client.terminate());
  await once(client, "open");
  const error = message(client);
  client.send(Buffer.from(JSON.stringify(hello)), { binary: true });
  assert.equal((await bounded(error)).code, "hello_required");
  assert.equal(started, false);
});

test("outbound provider adapter preserves text and binary frames and listener removal", async (t) => {
  const payload = JSON.stringify({ type: "turn.end", transcript: "hello" });
  const url = await fixture(t, (ws) => {
    ws.send(payload, { binary: false });
    ws.send(Buffer.from(payload), { binary: true });
  });
  const client = new WebSocket(url);
  t.after(() => client.terminate());
  const socket = adaptVoiceWebSocket(client);
  let removedCalls = 0;
  const removed = () => {
    removedCalls++;
  };
  socket.addEventListener("message", removed);
  socket.removeEventListener("message", removed);
  const values = await bounded(
    new Promise((resolve) => {
      const seen = [];
      socket.addEventListener("message", (event) => {
        seen.push(event.data);
        if (seen.length === 2) resolve(seen);
      });
    }),
  );
  assert.equal(values[0], payload);
  assert.ok(Buffer.isBuffer(values[1]));
  assert.deepEqual(values[1], Buffer.from(payload));
  assert.equal(removedCalls, 0);
});

test("real Ink adapter decodes a provider text frame over the normalized transport", async (t) => {
  const url = await fixture(t, (ws) =>
    ws.send(JSON.stringify({ type: "turn.end", transcript: "Hello Eliza" })),
  );
  let session;
  const event = await bounded(
    new Promise((resolve, reject) => {
      session = createCartesiaInkRealtimeSession({
        cartesiaApiKey: "fixture-key",
        webSocketFactory: () => adaptVoiceWebSocket(new WebSocket(url)),
        onEvent: (event) => {
          if (event.type === "end-of-turn") resolve(event);
          if (event.type === "error") reject(new Error(event.code));
        },
      });
      t.after(() => session.cancel());
    }),
  );
  assert.equal(event.transcript, "Hello Eliza");
});

test("real Sonic adapter decodes provider text into PCM over the normalized transport", async (t) => {
  const pcm = Buffer.from([0, 0, 1, 0, 255, 127, 0, 128]);
  const url = await fixture(t, (ws) =>
    ws.once("message", (data) => {
      const request = JSON.parse(String(data));
      ws.send(
        JSON.stringify({
          type: "chunk",
          context_id: request.context_id,
          data: pcm.toString("base64"),
        }),
      );
      ws.send(JSON.stringify({ type: "done", context_id: request.context_id }));
    }),
  );
  const adapter = new CartesiaSonicTtsAdapter({
    apiKey: "fixture-key",
    voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
    websocketFactory: () => adaptVoiceWebSocket(new WebSocket(url)),
  });
  t.after(() => adapter.close());
  const received = [];
  await bounded(
    new Promise((resolve, reject) => {
      const stream = adapter.createStream(
        { traceId: "trace" },
        {
          onAudioFrame: (event) => received.push(event),
          onComplete: resolve,
          onProviderError: (event) => reject(new Error(event.message)),
        },
      );
      stream.sendPhrase({ text: "Hello", continueContext: false });
    }),
  );
  assert.equal(received.length, 1);
  assert.deepEqual(Buffer.from(received[0].bytes), pcm);
});

// The standard script lane is Node. Keep the Bun regression in that lane too:
// Node alone normalizes ws.addEventListener text and cannot expose this bug.
if (!process.versions.bun) {
  test("the same wire regressions pass on Bun", () => {
    const child = spawnSync("bun", ["test", fileURLToPath(import.meta.url)], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  });
}
