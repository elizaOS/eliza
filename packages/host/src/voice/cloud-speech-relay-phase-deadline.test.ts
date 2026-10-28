import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import {
  type CloudSpeechRelayTransportDiagnostic,
  createCloudSpeechRelayPorts,
} from "./cloud-speech-relay-client";

function fixture(upgradeMs: number, readyMs: number, signal?: AbortSignal) {
  const id = crypto.randomUUID();
  const expiry = new Date(Date.now() + 60000).toISOString();
  const logs: CloudSpeechRelayTransportDiagnostic[] = [];
  const sent: string[] = [];
  const requests: string[] = [];
  let socket: WebSocket;
  let closed = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const fetcher = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      return Response.json(
        url.pathname.endsWith("/consent")
          ? { consentNonce: crypto.randomUUID(), expiresAt: expiry }
          : url.pathname.endsWith("/revoke")
            ? { revoked: true }
            : {
                sessionId: id,
                token: "private-fake-token",
                expiresAt: expiry,
                version: 1,
                wsUrl: `wss://example.invalid/api/v1/voice/speech/ws?sessionId=${id}`,
              },
      );
    },
    { preconnect() {} },
  ) as typeof fetch;
  const ready = () =>
    socket.onmessage?.({
      data: JSON.stringify({
        t: "ready",
        version: 1,
        sampleRate: 16000,
        channels: 1,
        expiresAt: expiry,
      }),
    } as MessageEvent);
  const open = () => {
    Object.assign(socket, { readyState: 1 });
    socket.onopen?.(new Event("open"));
  };
  const pending = createCloudSpeechRelayPorts({
    enabled: true,
    origin: "https://example.invalid",
    credential: async () => "private-fake-account",
    assertCurrent() {},
    fetch: fetcher,
    ...(signal ? { signal } : {}),
    logger: {
      warn(value) {
        logs.push(value as unknown as CloudSpeechRelayTransportDiagnostic);
      },
    },
    websocket(url) {
      socket = {
        url,
        readyState: 0,
        binaryType: "arraybuffer",
        send(value: string) {
          const t = JSON.parse(value).t;
          sent.push(t);
          if (t === "hello" && readyMs >= 0)
            timers.push(setTimeout(ready, readyMs));
        },
        close() {
          closed++;
          Object.assign(socket, { readyState: 3 });
        },
      } as unknown as WebSocket;
      if (upgradeMs >= 0) timers.push(setTimeout(open, upgradeMs));
      return socket;
    },
  });
  return {
    pending,
    logs,
    sent,
    requests,
    open,
    ready,
    get closed() {
      return closed;
    },
    cleanup() {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

test("three-second upgrade plus three-second ready succeeds within separate finite phase budgets", async () => {
  const f = fixture(3000, 3000);
  try {
    const ports = await f.pending;
    expect(f.logs.some((row) => row.cause === "startup_timeout")).toBe(false);
    for (const stage of ["websocket_connect", "relay_ready"]) {
      const row = f.logs.find(
        (row) => row.cause === "startup" && row.stage === stage,
      );
      if (!row) throw Error("Missing actual startup diagnostic");
      expect(row.durationMs).toBeGreaterThanOrEqual(2900);
      expect(row.durationMs).toBeLessThan(4500);
    }
    expect(f.sent).toEqual(["hello"]);
    await ports.close();
    expect(f.sent).toEqual(["hello", "stop"]);
    expect(f.requests.filter((path) => path.endsWith("/session"))).toHaveLength(
      1,
    );
    expect(f.requests.filter((path) => path.endsWith("/revoke"))).toHaveLength(
      1,
    );
  } finally {
    f.cleanup();
  }
}, 10000);

test("abort during upgrade fences late open and ready without hello or retry", async () => {
  const controller = new AbortController();
  const f = fixture(-1, -1, controller.signal);
  const result = f.pending.then(
    () => null,
    (error) => error,
  );
  await sleep(20);
  controller.abort();
  expect(await result).toBeInstanceOf(Error);
  f.open();
  f.ready();
  expect(f.sent).toEqual([]);
  expect(f.closed).toBeGreaterThan(0);
  expect(f.requests.filter((path) => path.endsWith("/session"))).toHaveLength(
    1,
  );
  expect(f.requests.filter((path) => path.endsWith("/revoke"))).toHaveLength(1);
  f.cleanup();
});

test("ready deadline closes opening socket without invalid STOP and late ready cannot revive it", async () => {
  const f = fixture(0, -1);
  try {
    const error = await f.pending.then(
      () => null,
      (error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(f.logs.find((row) => row.cause === "startup_timeout")).toMatchObject(
      { stage: "relay_ready", outcome: "failed" },
    );
    f.ready();
    expect(f.sent).toEqual(["hello"]);
    expect(f.closed).toBeGreaterThan(0);
    expect(f.requests.filter((path) => path.endsWith("/session"))).toHaveLength(
      1,
    );
    expect(f.requests.filter((path) => path.endsWith("/revoke"))).toHaveLength(
      1,
    );
  } finally {
    f.cleanup();
  }
}, 8000);
