import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { saveElizaConfig } from "../src/config/config.ts";
import { AgentMediaGenerationService } from "../src/services/media-generation.ts";

const API_KEY = "veo-secret-key";
const VIDEO_BYTES = Buffer.from("fixture-veo-mp4-bytes");
const DOWNLOAD_URI =
  "https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("stores the Veo video in the media store instead of returning the key-gated Files API URI", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "veo-media-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(directory, "eliza.json"));
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (new Headers(init?.headers).get("x-goog-api-key") !== API_KEY) {
        return new Response("API key missing", { status: 403 });
      }
      if (url.endsWith("/models/veo-2.0-generate-001:predictLongRunning")) {
        return Response.json({
          name: "models/veo-2.0-generate-001/operations/op1",
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: DOWNLOAD_URI } }],
            },
          },
        });
      }
      if (url === DOWNLOAD_URI) {
        return new Response(VIDEO_BYTES, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  const runtime = new AgentRuntime({
    character: { name: "Media", bio: [] },
    logLevel: "fatal",
  });
  try {
    saveElizaConfig({
      media: {
        video: {
          mode: "own-key",
          provider: "google",
          google: { apiKey: API_KEY },
        },
      },
    });
    const service = await AgentMediaGenerationService.start(runtime);
    const result = await service.generateMedia({
      mediaType: "video",
      prompt: "A lighthouse at dusk",
    });

    const hash = crypto.createHash("sha256").update(VIDEO_BYTES).digest("hex");
    expect(result.videoUrl).toBe(`/api/media/${hash}.mp4`);
    expect(result.url).toBe(`/api/media/${hash}.mp4`);
    expect(
      fs.readFileSync(path.join(directory, "media", `${hash}.mp4`)),
    ).toEqual(VIDEO_BYTES);
    expect(requested).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning",
      DOWNLOAD_URI,
    ]);
  } finally {
    await runtime.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("fails the generation when the Veo video download is rejected", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "veo-media-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(directory, "eliza.json"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(":predictLongRunning")) {
        return Response.json({
          name: "models/veo-2.0-generate-001/operations/op1",
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: DOWNLOAD_URI } }],
            },
          },
        });
      }
      return new Response("file expired", { status: 404 });
    }),
  );
  const runtime = new AgentRuntime({
    character: { name: "Media", bio: [] },
    logLevel: "fatal",
  });
  try {
    saveElizaConfig({
      media: {
        video: {
          mode: "own-key",
          provider: "google",
          google: { apiKey: API_KEY },
        },
      },
    });
    const service = await AgentMediaGenerationService.start(runtime);
    await expect(
      service.generateMedia({ mediaType: "video", prompt: "A lighthouse" }),
    ).rejects.toThrow("Google Veo error: file expired");
  } finally {
    await runtime.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
