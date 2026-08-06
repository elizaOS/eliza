/**
 * Deterministic contract tests for the staging voice latency harness. The
 * socket is an in-memory EventTarget; no provider, network, or spend is used.
 */

import { describe, expect, test } from "bun:test";
import {
  measureTurn,
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

  test("rejects zero and non-integer turn timeouts", () => {
    expect(() =>
      parseArgs([...requiredArgs, "--turn-timeout-ms", "0"], {}),
    ).toThrow("positive integer");
    expect(() =>
      parseArgs([...requiredArgs, "--turn-timeout-ms", "1.5"], {}),
    ).toThrow("positive integer");
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
