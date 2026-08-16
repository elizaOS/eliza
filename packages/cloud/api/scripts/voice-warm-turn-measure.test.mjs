/**
 * Deterministic contract tests for the staging voice latency harness. The
 * socket is an in-memory EventTarget; no provider, network, or spend is used.
 */

import { describe, expect, test } from "bun:test";
import {
  measureTurn,
  mintLocalMeasurementSession,
  parseArgs,
  summarize,
} from "./voice-warm-turn-measure.mjs";

const requiredArgs = [
  "--ws-url",
  "wss://staging.example/api/v1/voice/session/ws?sessionId=test",
  "--token",
  "scoped-token",
  "--pcm",
  "speech.pcm",
];

describe("voice warm-turn argument contract", () => {
  test("requires a real WebSocket target and at least 20 measured turns", () => {
    expect(() => parseArgs(requiredArgs, {})).not.toThrow();
    expect(() =>
      parseArgs(requiredArgs.with(1, "https://staging.example/voice"), {}),
    ).toThrow("ws:// or wss://");
    expect(() => parseArgs([...requiredArgs, "--turns", "19"], {})).toThrow(
      ">= 20",
    );
  });

  test("accepts a credential-free loopback mode with explicit HTTP origins", () => {
    const localArgs = [
      "--local-origin",
      "http://127.0.0.1:32338",
      "--runtime-origin",
      "http://127.0.0.1:2138",
      "--pcm",
      "speech.pcm",
    ];
    expect(parseArgs(localArgs, {})).toMatchObject({
      localTurnsPerSession: 8,
    });
    expect(() =>
      parseArgs(localArgs.with(1, "ws://127.0.0.1:32338"), {}),
    ).toThrow("http:// or https://");
    expect(() =>
      parseArgs([...localArgs, "--local-turns-per-session", "11"], {}),
    ).toThrow("from 1 to 10");
  });

  test("rejects zero and non-integer turn timeouts", () => {
    expect(() =>
      parseArgs([...requiredArgs, "--turn-timeout-ms", "0"], {}),
    ).toThrow("positive integer");
    expect(() =>
      parseArgs([...requiredArgs, "--turn-timeout-ms", "1.5"], {}),
    ).toThrow("positive integer");
  });
});

describe("local voice warm-turn session isolation", () => {
  test("creates a fresh conversation and keeps the scoped token in memory", async () => {
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (url.pathname === "/api/conversations") {
        return Response.json({
          conversation: { id: "11111111-1111-4111-8111-111111111111" },
        });
      }
      if (url.pathname.endsWith("/consent")) {
        return Response.json({ consentNonce: "one-time-consent" });
      }
      return Response.json({
        wsUrl: "ws://127.0.0.1:32338/api/v1/voice/session/ws?sessionId=local",
        token: "short-lived-token",
      });
    };

    await expect(
      mintLocalMeasurementSession(
        {
          localOrigin: "http://127.0.0.1:32338",
          runtimeOrigin: "http://127.0.0.1:2138",
          turnIndex: 7,
        },
        fetchImpl,
      ),
    ).resolves.toEqual({
      wsUrl: "ws://127.0.0.1:32338/api/v1/voice/session/ws?sessionId=local",
      token: "short-lived-token",
    });
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      "/api/conversations",
      "/api/v1/voice/session/consent",
      "/api/v1/voice/session",
    ]);
    const createBody = JSON.parse(calls[0].init.body);
    expect(createBody).toMatchObject({
      metadata: { scope: "general" },
    });
    const mintBody = JSON.parse(calls[2].init.body);
    expect(mintBody).toEqual({
      conversationId: "11111111-1111-4111-8111-111111111111",
      consentNonce: "one-time-consent",
      transport: "websocket",
    });
  });
});

describe("voice warm-turn measurements", () => {
  test("summarizes a non-empty measured sample set", () => {
    expect(summarize([10, 20, 30, 40])).toEqual({
      count: 4,
      p50Ms: 20,
      p95Ms: 40,
      maxMs: 40,
    });
    expect(() => summarize([])).toThrow("empty sample set");
  });

  test("settles only after STT, first text, first audio, and usage", async () => {
    const socket = new EventTarget();
    const turn = measureTurn(socket, 7, true, 1_000);
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          t: "stt_final",
          traceId: "trace-7",
          text: "hello",
        }),
      }),
    );
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ t: "llm_first_text" }),
      }),
    );
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          t: "assistant_output",
          displayMarkdown: "hello",
          speechText: "hello",
        }),
      }),
    );
    socket.dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array([1]).buffer }),
    );
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ t: "usage" }),
      }),
    );

    await expect(turn.promise).resolves.toMatchObject({
      turnIndex: 7,
      counted: true,
      traceId: "trace-7",
      text: "hello",
    });
  });

  test("fails immediately on malformed or provider-error control frames", async () => {
    const malformedSocket = new EventTarget();
    const malformed = measureTurn(malformedSocket, 1, false, 1_000);
    malformedSocket.dispatchEvent(
      new MessageEvent("message", { data: "not-json" }),
    );
    await expect(malformed.promise).rejects.toThrow("invalid control frame");

    const failedSocket = new EventTarget();
    const failed = measureTurn(failedSocket, 2, false, 1_000);
    failedSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ t: "error", code: "provider_down" }),
      }),
    );
    await expect(failed.promise).rejects.toThrow("provider_down");
  });
});
