import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, type MediaGenerationResponse } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { saveElizaConfig } from "../src/config/config.ts";
import { AgentMediaGenerationService } from "../src/services/media-generation.ts";

const API_KEY = "veo-secret-key";
const VIDEO_BYTES = Buffer.from("fixture-veo-mp4-bytes");
const VIDEO_HASH = crypto
  .createHash("sha256")
  .update(VIDEO_BYTES)
  .digest("hex");
const DOWNLOAD_URI =
  "https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media";
const PREDICT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning";
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function completedOperation(): Response {
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

async function generateVideo(
  handleDownload: FetchHandler,
  check: (
    result: Promise<MediaGenerationResponse>,
    mediaDir: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "veo-media-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(directory, "eliza.json"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === PREDICT_URL) {
        return new Headers(init?.headers).get("x-goog-api-key") === API_KEY
          ? completedOperation()
          : new Response("API key missing", { status: 403 });
      }
      return handleDownload(url, init);
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
    await check(
      service.generateMedia({
        mediaType: "video",
        prompt: "A lighthouse at dusk",
      }),
      path.join(directory, "media"),
    );
  } finally {
    await runtime.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function storedVideoFiles(mediaDir: string): string[] {
  if (!fs.existsSync(mediaDir)) return [];
  return fs.readdirSync(mediaDir).filter((name) => name.endsWith(".mp4"));
}

it("stores the Veo video in the media store instead of returning the key-gated Files API URI", async () => {
  const requested: string[] = [];
  await generateVideo(
    async (url, init) => {
      requested.push(url);
      if (url !== DOWNLOAD_URI)
        return new Response("not found", { status: 404 });
      if (new Headers(init?.headers).get("x-goog-api-key") !== API_KEY) {
        return new Response("API key missing", { status: 403 });
      }
      return new Response(VIDEO_BYTES, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    },
    async (pending, mediaDir) => {
      const result = await pending;
      expect(result.videoUrl).toBe(`/api/media/${VIDEO_HASH}.mp4`);
      expect(result.url).toBe(`/api/media/${VIDEO_HASH}.mp4`);
      expect(fs.readFileSync(path.join(mediaDir, `${VIDEO_HASH}.mp4`))).toEqual(
        VIDEO_BYTES,
      );
      expect(requested).toEqual([DOWNLOAD_URI]);
    },
  );
});

it("fails the generation when the Veo video download is rejected", async () => {
  await generateVideo(
    async () => new Response("file expired", { status: 404 }),
    async (pending) => {
      await expect(pending).rejects.toThrow("Google Veo error: file expired");
    },
  );
});

it("does not send the API key to a cross-origin download redirect", async () => {
  const keysByUrl: Array<[string, string | null]> = [];
  const signedUrl = "https://video-storage.example/signed/abc123";
  await generateVideo(
    async (url, init) => {
      keysByUrl.push([url, new Headers(init?.headers).get("x-goog-api-key")]);
      if (url === DOWNLOAD_URI) {
        return new Response(null, {
          status: 302,
          headers: { location: signedUrl },
        });
      }
      if (url === signedUrl) {
        return new Response(VIDEO_BYTES, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      return new Response("not found", { status: 404 });
    },
    async (pending) => {
      const result = await pending;
      expect(result.videoUrl).toBe(`/api/media/${VIDEO_HASH}.mp4`);
      expect(keysByUrl).toEqual([
        [DOWNLOAD_URI, API_KEY],
        [signedUrl, null],
      ]);
    },
  );
});

it("rejects a Veo download whose body stalls past the download deadline", async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const downloadDeadline = new AbortController();
  const timeoutSpy = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) =>
      ms === VIDEO_DOWNLOAD_TIMEOUT_MS
        ? downloadDeadline.signal
        : originalTimeout(ms),
    );
  let markHeadersSent!: () => void;
  const headersSent = new Promise<void>((resolve) => {
    markHeadersSent = resolve;
  });
  await generateVideo(
    async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(VIDEO_BYTES));
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal?.reason),
          );
        },
      });
      markHeadersSent();
      return new Response(body, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    },
    async (pending, mediaDir) => {
      const outcome = pending.then(
        () => "resolved",
        (error: Error) => error.message,
      );
      await headersSent;
      downloadDeadline.abort(
        new DOMException("The download deadline elapsed", "TimeoutError"),
      );
      expect(await outcome).toBe(
        "[google] Network error: The download deadline elapsed",
      );
      expect(timeoutSpy).toHaveBeenCalledWith(VIDEO_DOWNLOAD_TIMEOUT_MS);
      expect(storedVideoFiles(mediaDir)).toEqual([]);
    },
  );
});

it("rejects a Veo download larger than the attachment byte limit", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulledBytes = 0;
  await generateVideo(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulledBytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "video/mp4" } },
      ),
    async (pending, mediaDir) => {
      await expect(pending).rejects.toThrow(
        `payload exceeds maxBytes ${VIDEO_MAX_BYTES}`,
      );
      expect(pulledBytes).toBeLessThanOrEqual(
        VIDEO_MAX_BYTES + 4 * chunk.byteLength,
      );
      expect(storedVideoFiles(mediaDir)).toEqual([]);
    },
  );
});
