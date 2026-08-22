/**
 * Exercises the production Fish Audio WebSocket/MessagePack client against a
 * resettable local protocol service with deterministic faults and readback.
 */

import { startFishAudioMock } from "@elizaos/cloud-test-mocks/fish-audio";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
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

async function startMock() {
  const mock = await startFishAudioMock();
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
