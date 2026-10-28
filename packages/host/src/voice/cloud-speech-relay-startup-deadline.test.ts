import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  CloudSpeechRelayClientError,
  type CloudSpeechRelayTransportDiagnostic,
  createCloudSpeechRelayPorts,
} from "./cloud-speech-relay-client";

for (const opens of [false, true])
  test(`bounded startup ${opens ? "opened/no-ready" : "no-open"} preserves exact event sequence`, async () => {
    const id = crypto.randomUUID(),
      logs: CloudSpeechRelayTransportDiagnostic[] = [],
      calls: string[] = [],
      sent: { t: string }[] = [],
      expiry = new Date(Date.now() + 60000).toISOString();
    let socket: {
      url: string;
      readyState: number;
      onopen?: (event: Event) => void;
      onerror?: (event: Event) => void;
      onclose?: (event: { code: number; wasClean: boolean }) => void;
      send(value: string): void;
      close(): void;
    };
    const fakeFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        return Response.json(
          url.pathname.endsWith("/consent")
            ? { consentNonce: crypto.randomUUID(), expiresAt: expiry }
            : url.pathname.endsWith("/revoke")
              ? { revoked: true }
              : {
                  sessionId: id,
                  token: "fake-test-token",
                  expiresAt: expiry,
                  wsUrl: `wss://example.invalid/api/v1/voice/speech/ws?sessionId=${id}`,
                  version: 1,
                },
        );
      },
      { preconnect() {} },
    );
    const start = performance.now();
    let failure: unknown;
    try {
      await createCloudSpeechRelayPorts({
        enabled: true,
        origin: "https://example.invalid",
        credential: async () => "fake-account",
        assertCurrent() {},
        fetch: fakeFetch,
        logger: {
          warn(x: unknown) {
            logs.push(x as CloudSpeechRelayTransportDiagnostic);
          },
        },
        websocket(url) {
          socket = {
            url,
            readyState: 0,
            send(v: string) {
              sent.push(JSON.parse(v));
            },
            close() {
              this.readyState = 3;
              this.onerror?.(new Event("error"));
              this.onclose?.({ code: 1006, wasClean: false });
            },
          };
          if (opens)
            queueMicrotask(() => {
              socket.readyState = 1;
              socket.onopen?.(new Event("open"));
            });
          return socket as unknown as WebSocket;
        },
      });
    } catch (e) {
      failure = e;
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(6500);
    expect(calls.filter((x) => x.endsWith("/session"))).toHaveLength(1);
    expect(calls.filter((x) => x.endsWith("/revoke"))).toHaveLength(1);
    expect(
      logs.some(
        (x) => x.cause === "startup" && x.stage === "websocket_connect",
      ),
    ).toBe(opens);
    expect(
      logs.some((x) => x.cause === "startup" && x.stage === "relay_ready"),
    ).toBe(false);
    expect(logs.find((x) => x.cause === "socket_error")?.phase).toBe(
      "retiring",
    );
    expect(failure).toBeInstanceOf(CloudSpeechRelayClientError);
    if (!(failure instanceof CloudSpeechRelayClientError)) throw failure;
    expect(failure.code).toBe("transport");
    expect(logs.find((x) => x.cause === "startup_timeout")).toMatchObject({
      phase: "connecting",
      stage: opens ? "relay_ready" : "websocket_connect",
      outcome: "failed",
    });
    expect(
      logs.find((entry) => entry.cause === "minted_session"),
    ).toMatchObject({
      phase: "bootstrap",
      speechSessionDigest: createHash("sha256")
        .update(JSON.stringify({ cloudSessionId: id }))
        .digest("hex"),
    });
    expect(JSON.stringify(logs)).not.toContain(id);
    expect(sent.map((frame) => frame.t)).toEqual(opens ? ["hello"] : []);
    expect(JSON.stringify(logs)).not.toContain("fake-test-token");
  }, 10000);
