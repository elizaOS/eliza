import { once } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { AgentRuntime, ModelType, runWithStreamingContext } from "@elizaos/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { handleAudioGeneration, handleVideoGeneration } from "../src/models/media";
import { handleTextToSpeech } from "../src/models/speech";

const CLOUD_ENV_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_USE_TTS",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of CLOUD_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CLOUD_ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

const cases = [
  {
    name: "video",
    path: "/api/v1/generate-video",
    modelType: ModelType.VIDEO,
    handler: handleVideoGeneration,
    params: { prompt: "a fox running through snow" },
  },
  {
    name: "music",
    path: "/api/v1/generate-music",
    modelType: ModelType.AUDIO,
    handler: handleAudioGeneration,
    params: { prompt: "a calm synthwave loop", audioKind: "music" },
  },
  {
    name: "speech",
    path: "/api/v1/voice/tts",
    modelType: ModelType.TEXT_TO_SPEECH,
    handler: handleTextToSpeech,
    params: { text: "Read this aloud" },
  },
] as const;

it.each(cases)(
  "cancelling the turn aborts the in-flight Eliza Cloud $name request",
  async ({ path, modelType, handler, params }) => {
    const received: string[] = [];
    let markArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    let markClosed!: () => void;
    const closedByClient = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const server = http.createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      res.on("close", () => {
        if (!res.writableEnded) markClosed();
      });
      req.resume();
      markArrived();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");

    const runtime = new AgentRuntime({
      character: {
        name: "Media",
        bio: [],
        settings: {
          secrets: {
            ELIZAOS_CLOUD_API_KEY: "eliza_test_placeholder",
            ELIZAOS_CLOUD_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
            ELIZAOS_CLOUD_ENABLED: "true",
          },
        },
      },
      logLevel: "fatal",
    });
    runtime.registerModel(
      modelType,
      handler as Parameters<typeof runtime.registerModel>[1],
      "elizacloud"
    );

    const controller = new AbortController();
    try {
      const roomId = "00000000-0000-4000-8000-000000000001";
      const turn = runtime.roomHandlerQueue
        .runWith(roomId, () =>
          runWithStreamingContext({ abortSignal: controller.signal }, () =>
            runtime.useModel(modelType, { ...params } as never)
          )
        )
        .then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.name : String(error))
        );
      await arrived;
      controller.abort(new DOMException("User pressed stop", "AbortError"));
      const nextTurn = runtime.roomHandlerQueue.runWith(roomId, async () => "ran");

      const outcome = await Promise.race([turn, delay(2_000, "still-pending")]);
      const next = await Promise.race([nextTurn, delay(2_000, "blocked")]);
      const upstream = await Promise.race([
        closedByClient.then(() => "aborted"),
        delay(2_000, "still-open"),
      ]);

      expect(received).toEqual([`POST ${path}`]);
      expect({ outcome, next, upstream }).toEqual({
        outcome: "AbortError",
        next: "ran",
        upstream: "aborted",
      });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
  15_000
);
