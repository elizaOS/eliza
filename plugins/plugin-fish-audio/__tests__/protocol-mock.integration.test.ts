/**
 * Exercises the production Fish Audio WebSocket/MessagePack client against a
 * resettable local protocol service with deterministic faults and readback.
 */

import { startFishAudioMock } from "@elizaos/cloud-test-mocks/fish-audio";
import type { IAgentRuntime } from "@elizaos/core";
import { decode, encode } from "@msgpack/msgpack";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { createFishAudioNodeWebSocketFactory } from "../node-transport";
import {
  classifyFishAudioFailure,
  configureFishAudioWebSocketFactory,
  handleFishAudioTextToSpeech,
} from "../src/index";

const runningMocks: Awaited<ReturnType<typeof startFishAudioMock>>[] = [];

function runtime(apiKey = "synthetic-fish-key"): IAgentRuntime {
  const settings: Record<string, string> = {
    ELIZA_TTS_FISH_ENABLED: "true",
    FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
    FISH_AUDIO_API_KEY: apiKey,
    FISH_AUDIO_REFERENCE_ID: "synthetic-voice",
  };
  return {
    getSetting: (key: string) => settings[key],
  } as IAgentRuntime;
}

async function startMock(seed: Parameters<typeof startFishAudioMock>[0] = {}) {
  const mock = await startFishAudioMock(seed);
  runningMocks.push(mock);
  configureFishAudioWebSocketFactory(
    createFishAudioNodeWebSocketFactory(mock.url),
  );
  return mock;
}

async function streamingResult(
  input: Parameters<typeof handleFishAudioTextToSpeech>[1],
  apiKey?: string,
) {
  const result = await handleFishAudioTextToSpeech(runtime(apiKey), {
    ...input,
    audioStream: true,
  });
  if (result instanceof Uint8Array)
    throw new Error("Expected streaming result");
  return result;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out awaiting mock readback");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function serializeFailure(error: unknown): string {
  return JSON.stringify(
    {
      direct: String(error),
      error,
    },
    (_key, value) => {
      if (!(value instanceof Error)) return value;
      const fields = new Set([
        "name",
        "message",
        "stack",
        "cause",
        ...Object.keys(value),
      ]);
      return Object.fromEntries(
        [...fields].map((field) => [
          field,
          (value as unknown as Record<string, unknown>)[field],
        ]),
      );
    },
  );
}

function expectSanitizedFailure(
  error: unknown,
  secret: string,
  expected: { code: string; message: string },
): void {
  expect(error).toMatchObject(expected);
  expect(serializeFailure(error)).not.toContain(secret);
}

afterEach(async () => {
  configureFishAudioWebSocketFactory(undefined);
  await Promise.all(runningMocks.splice(0).map((mock) => mock.stop()));
});

describe("Fish Audio protocol mock", () => {
  test("streams seeded chunks through the real client and exposes resettable redacted readback", async () => {
    const mock = await startMock();
    const result = await streamingResult({ text: "synthetic hello" });
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.audioStream) chunks.push(chunk);

    expect(chunks).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    expect(await result.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    await waitFor(() =>
      mock.store
        .readback()
        .observations.some((entry) => entry.event === "closed"),
    );
    const readback = mock.store.readback();
    expect(
      readback.observations
        .filter((entry) => entry.event === "frame")
        .map((entry) => entry.frameEvent),
    ).toEqual(["start", "text", "flush", "stop"]);
    expect(readback.observations).toContainEqual(
      expect.objectContaining({
        event: "request",
        model: "s2.1-pro",
        referenceId: "synthetic-voice",
        text: "synthetic hello",
        requestValid: true,
      }),
    );
    expect(JSON.stringify(readback)).not.toContain("synthetic-fish-key");

    const generation = readback.generation;
    mock.store.setFault("provider_error");
    mock.store.reset({ audioChunks: [new Uint8Array([9, 8])] });
    expect(mock.store.readback()).toEqual({
      generation: generation + 1,
      fault: null,
      observations: [],
    });
    expect(mock.store.seed.audioChunks).toEqual([new Uint8Array([9, 8])]);
  });

  test("rejects out-of-order client frames instead of fabricating synthesis", async () => {
    const mock = await startMock();
    const socket = new WebSocket(mock.url, {
      headers: {
        Authorization: "Bearer synthetic-fish-key",
        model: "s2.1-pro",
      },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("message", (data) => {
        try {
          resolve(
            decode(new Uint8Array(data as Buffer)) as Record<string, unknown>,
          );
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    });

    socket.send(encode({ event: "stop" }));

    await expect(response).resolves.toMatchObject({
      event: "error",
      error: "invalid_request",
    });
    await waitFor(() => mock.store.openConnectionCount === 0);
    expect(mock.store.readback().observations).toContainEqual(
      expect.objectContaining({ event: "protocol_rejected" }),
    );
    expect(
      mock.store
        .readback()
        .observations.some((entry) => entry.event === "request"),
    ).toBe(false);
  });

  test("stops provider work when a streaming consumer closes its iterator", async () => {
    const mock = await startMock({
      audioChunks: [
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4]),
        new Uint8Array([5, 6]),
      ],
      chunkDelayMs: 25,
    });
    const result = await streamingResult({ text: "consume one chunk" });
    const iterator = result.audioStream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: new Uint8Array([1, 2]),
    });
    await iterator.return?.();

    await expect(result.bytes).rejects.toMatchObject({
      code: "FISH_AUDIO_STREAM_ABORTED",
    });
    await waitFor(() => mock.store.openConnectionCount === 0);
  });

  test("rejects authentication without recording the credential", async () => {
    const mock = await startMock();
    const result = await streamingResult(
      { text: "wrong key" },
      "secret-wrong-key",
    );

    const error = await result.bytes.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "FISH_AUDIO_AUTH_FAILED" });
    expect(classifyFishAudioFailure(error)).toEqual({
      category: "auth",
      retryable: false,
    });
    expect(mock.store.readback().observations).toContainEqual(
      expect.objectContaining({
        event: "upgrade_rejected",
        authorized: false,
        status: 401,
      }),
    );
    expect(JSON.stringify(mock.store.readback())).not.toContain(
      "secret-wrong-key",
    );
  });

  test("does not let a configured rate-limit fault mask invalid credentials", async () => {
    const mock = await startMock();
    mock.store.setFault("rate_limit");
    const result = await streamingResult(
      { text: "wrong key during provider throttling" },
      "secret-wrong-key",
    );

    await expect(result.bytes).rejects.toMatchObject({
      code: "FISH_AUDIO_AUTH_FAILED",
    });
    expect(mock.store.readback().observations).toContainEqual(
      expect.objectContaining({
        event: "upgrade_rejected",
        authorized: false,
        status: 401,
      }),
    );
  });

  test("classifies rate limiting as retryable", async () => {
    const mock = await startMock();
    mock.store.setFault("rate_limit");
    const result = await streamingResult({ text: "retry later" });

    const error = await result.bytes.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "FISH_AUDIO_RATE_LIMITED" });
    expect(classifyFishAudioFailure(error)).toEqual({
      category: "rate_limit",
      retryable: true,
    });
    expect(mock.store.readback().observations).toContainEqual(
      expect.objectContaining({ event: "upgrade_rejected", status: 429 }),
    );
  });

  test("rejects malformed MessagePack and provider-declared failures", async () => {
    const mock = await startMock();
    mock.store.setFault("malformed_frame");
    const malformed = await streamingResult({ text: "bad bytes" });
    const malformedError = await malformed.bytes.catch(
      (failure: unknown) => failure,
    );
    expect(malformedError).toMatchObject({
      code: "FISH_AUDIO_PROVIDER_MESSAGE_INVALID",
    });
    expect(classifyFishAudioFailure(malformedError)).toEqual({
      category: "invalid_response",
      retryable: false,
    });
    await waitFor(() => mock.store.openConnectionCount === 0);

    mock.store.reset();
    mock.store.setFault("array_frame");
    const arrayFrame = await streamingResult({ text: "array frame" });
    await expect(arrayFrame.bytes).rejects.toMatchObject({
      code: "FISH_AUDIO_PROVIDER_MESSAGE_INVALID",
    });
    await waitFor(() => mock.store.openConnectionCount === 0);

    mock.store.reset();
    mock.store.setFault("provider_error");
    const failed = await streamingResult({ text: "provider failure" });
    const providerError = await failed.bytes.catch(
      (failure: unknown) => failure,
    );
    expect(providerError).toMatchObject({ code: "FISH_AUDIO_PROVIDER_ERROR" });
    expect(classifyFishAudioFailure(providerError)).toEqual({
      category: "provider",
      retryable: false,
    });
    await waitFor(() => mock.store.openConnectionCount === 0);
  });

  test("redacts provider frame, close, and upgrade text from every public error surface", async () => {
    const mock = await startMock();
    const frameSecret = "FRAME_SECRET_do-not-reflect_7e11";
    mock.store.setFault("provider_error", { providerMessage: frameSecret });
    const providerFailure = await streamingResult({ text: "frame failure" });
    const providerError = await providerFailure.bytes.catch(
      (failure: unknown) => failure,
    );
    expectSanitizedFailure(providerError, frameSecret, {
      code: "FISH_AUDIO_PROVIDER_ERROR",
      message: "Fish Audio provider reported an error",
    });
    expect(classifyFishAudioFailure(providerError)).toEqual({
      category: "provider",
      retryable: false,
    });
    await waitFor(() => mock.store.openConnectionCount === 0);
    expect(JSON.stringify(mock.store.readback())).not.toContain(frameSecret);

    mock.store.reset();
    const closeSecret = "CLOSE_SECRET_do-not-reflect_28c4";
    mock.store.setFault("close_early", { closeReason: closeSecret });
    const closed = await streamingResult({ text: "close failure" });
    const closeError = await closed.bytes.catch((failure: unknown) => failure);
    expectSanitizedFailure(closeError, closeSecret, {
      code: "FISH_AUDIO_WEBSOCKET_CLOSED_EARLY",
      message: "Fish Audio WebSocket closed before synthesis completed",
    });
    expect(closeError).toMatchObject({ context: { closeCode: 1011 } });
    expect(classifyFishAudioFailure(closeError)).toEqual({
      category: "transport",
      retryable: true,
    });
    await waitFor(() => mock.store.openConnectionCount === 0);
    expect(JSON.stringify(mock.store.readback())).not.toContain(closeSecret);

    mock.store.reset();
    const upgradeSecret = "UPGRADE_SECRET_do-not-reflect_a090";
    mock.store.setFault("rate_limit", { upgradeStatusText: upgradeSecret });
    const rejected = await streamingResult({ text: "upgrade failure" });
    const upgradeError = await rejected.bytes.catch(
      (failure: unknown) => failure,
    );
    expectSanitizedFailure(upgradeError, upgradeSecret, {
      code: "FISH_AUDIO_RATE_LIMITED",
      message: "Fish Audio rate limit exceeded",
    });
    expect(upgradeError).toMatchObject({
      context: { retryable: true, statusCode: 429 },
    });
    expect(classifyFishAudioFailure(upgradeError)).toEqual({
      category: "rate_limit",
      retryable: true,
    });
    expect(JSON.stringify(mock.store.readback())).not.toContain(upgradeSecret);
  });

  test("cancels and times out stalled real protocol sessions", async () => {
    const mock = await startMock();
    mock.store.setFault("stall");
    const controller = new AbortController();
    const cancelled = await streamingResult({
      text: "cancel me",
      signal: controller.signal,
    });
    await waitFor(() =>
      mock.store
        .readback()
        .observations.some((entry) => entry.event === "request"),
    );
    controller.abort();
    const cancelledError = await cancelled.bytes.catch(
      (failure: unknown) => failure,
    );
    expect(cancelledError).toMatchObject({ code: "FISH_AUDIO_STREAM_ABORTED" });
    expect(classifyFishAudioFailure(cancelledError)).toEqual({
      category: "cancelled",
      retryable: false,
    });
    await waitFor(() => mock.store.openConnectionCount === 0);

    mock.store.reset();
    mock.store.setFault("stall");
    const staleGeneration = mock.store.generation;
    const stale = await streamingResult({ text: "reset this session" });
    await waitFor(() =>
      mock.store
        .readback()
        .observations.some((entry) => entry.event === "request"),
    );
    mock.store.reset();
    await expect(stale.bytes).rejects.toMatchObject({
      code: "FISH_AUDIO_WEBSOCKET_CLOSED_EARLY",
    });
    await waitFor(() => mock.store.openConnectionCount === 0);
    expect(mock.store.readback()).toEqual({
      generation: staleGeneration + 1,
      fault: null,
      observations: [],
    });

    mock.store.setFault("stall");
    const timedOut = await streamingResult({
      text: "time out",
      synthesisTimeoutMs: 25,
    });
    const timeoutError = await timedOut.bytes.catch(
      (failure: unknown) => failure,
    );
    expect(timeoutError).toMatchObject({
      code: "FISH_AUDIO_SYNTHESIS_TIMEOUT",
    });
    expect(classifyFishAudioFailure(timeoutError)).toEqual({
      category: "timeout",
      retryable: true,
    });
    await waitFor(() => mock.store.openConnectionCount === 0);
  });
});
