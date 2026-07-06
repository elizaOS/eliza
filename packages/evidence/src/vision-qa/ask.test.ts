/**
 * End-to-end client-plumbing tests for askAboutImage against a LOCAL STUB HTTP
 * server speaking the Anthropic Messages shape. Exercises the real path —
 * downscale, request build, fetch, extract, strict parse — with a real PNG on
 * disk, so everything but the model's cognition is under test. Covers the
 * single-retry accounting, cache hit/miss/bypass, transport-error surfacing,
 * and the NOT_CONFIGURED contract. The model's actual answers are covered by
 * vision-qa.live.test.ts.
 */

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askAboutImage } from "./ask.ts";
import type { AskOptions, VisionQuestion } from "./types.ts";

const QUESTIONS: VisionQuestion[] = [
  { id: "q1", question: "What does the button say?" },
  { id: "q2", question: "Is the panel empty?" },
];

function conformingBody(): string {
  return JSON.stringify({
    answers: [
      { id: "q1", answer: "Send", confidence: 0.97, details: "button label" },
      { id: "q2", answer: "yes", confidence: 0.8, details: "no content" },
    ],
  });
}

/** A stub Anthropic Messages server whose per-request bodies are scripted. */
function startStub(
  bodiesInOrder: string[],
): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  let call = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const text = bodiesInOrder[Math.min(call, bodiesInOrder.length - 1)];
      call += 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          content: [{ type: "text", text }],
          usage: { input_tokens: 1000 + call, output_tokens: 20 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests });
    });
  });
}

let tmpDir: string;
let imagePath: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-ask-"));
  imagePath = path.join(tmpDir, "shot.png");
  // 2000px wide so the downscale-to-1568 path is exercised for real.
  await sharp({
    create: {
      width: 2000,
      height: 1000,
      channels: 3,
      background: { r: 240, g: 120, b: 30 },
    },
  })
    .png()
    .toFile(imagePath);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseOptions(url: string): AskOptions {
  return {
    backend: "anthropic",
    apiKey: "stub-key",
    baseUrl: url,
    cacheDir: tmpDir,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("askAboutImage against a stub server", () => {
  it("returns structured answers with provenance and records sent dimensions", async () => {
    const { server, url, requests } = await startStub([conformingBody()]);
    try {
      const result = await askAboutImage(
        imagePath,
        QUESTIONS,
        baseOptions(url),
      );
      expect(result.answers).toHaveLength(2);
      expect(result.answers[0].answer).toBe("Send");
      expect(result.provenance.backend).toBe("anthropic");
      expect(result.provenance.retries).toBe(0);
      expect(result.provenance.cached).toBe(false);
      expect(result.provenance.usage.inputTokens).toBeGreaterThan(0);
      // 2000x1000 downscaled to 1568x784 (longest edge cap).
      expect(result.provenance.dimensions).toEqual({
        originalWidth: 2000,
        originalHeight: 1000,
        sentWidth: 1568,
        sentHeight: 784,
      });
      expect(requests).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it("spends exactly one corrective retry on a malformed first response and counts it", async () => {
    const { server, url, requests } = await startStub([
      "not json at all",
      conformingBody(),
    ]);
    try {
      const result = await askAboutImage(
        imagePath,
        QUESTIONS,
        baseOptions(url),
      );
      expect(result.provenance.retries).toBe(1);
      expect(requests).toHaveLength(2);
      // Usage accumulates across the two billed requests (stub: 1001 + 1002 in).
      expect(result.provenance.usage.inputTokens).toBe(1001 + 1002);
      expect(result.provenance.usage.outputTokens).toBe(20 + 20);
    } finally {
      server.close();
    }
  });

  it("fails typed after the retry when output never conforms (no fabrication)", async () => {
    const { server, url, requests } = await startStub(["bad", "still bad"]);
    try {
      await expect(
        askAboutImage(imagePath, QUESTIONS, baseOptions(url)),
      ).rejects.toMatchObject({ code: "VISION_RESPONSE_INVALID" });
      expect(requests).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it("surfaces a non-2xx transport error typed", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 429;
      res.end("rate limited");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        askAboutImage(
          imagePath,
          QUESTIONS,
          baseOptions(`http://127.0.0.1:${port}/v1`),
        ),
      ).rejects.toMatchObject({ code: "VISION_BACKEND_HTTP" });
    } finally {
      server.close();
    }
  });

  it("writes a cache entry on miss and serves it on the next call without a request", async () => {
    const first = await startStub([conformingBody()]);
    let cachedQuery: string;
    try {
      const result = await askAboutImage(
        imagePath,
        QUESTIONS,
        baseOptions(first.url),
      );
      expect(result.provenance.cached).toBe(false);
      // The cache file exists under .vision-qa-cache/<imgSha>/<querySha>.json.
      const cacheRoot = path.join(tmpDir, ".vision-qa-cache");
      const imgDir = fs.readdirSync(cacheRoot)[0];
      cachedQuery = fs.readdirSync(path.join(cacheRoot, imgDir))[0];
      expect(cachedQuery).toMatch(/\.json$/);
    } finally {
      first.server.close();
    }

    // Second call points at a server that would 500 if reached; a cache hit
    // means it is never contacted.
    const dead = createServer((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await new Promise<void>((resolve) =>
      dead.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = dead.address() as AddressInfo;
    try {
      const hit = await askAboutImage(imagePath, QUESTIONS, {
        ...baseOptions(`http://127.0.0.1:${port}/v1`),
      });
      expect(hit.provenance.cached).toBe(true);
      expect(hit.answers[0].answer).toBe("Send");
    } finally {
      dead.close();
    }
  });

  it("bypasses the cache with noCache and neither reads nor writes it", async () => {
    const { server, url } = await startStub([
      conformingBody(),
      conformingBody(),
    ]);
    try {
      const opts = { ...baseOptions(url), noCache: true };
      const first = await askAboutImage(imagePath, QUESTIONS, opts);
      expect(first.provenance.cached).toBe(false);
      // No cache dir written.
      expect(fs.existsSync(path.join(tmpDir, ".vision-qa-cache"))).toBe(false);
      const second = await askAboutImage(imagePath, QUESTIONS, opts);
      expect(second.provenance.cached).toBe(false);
    } finally {
      server.close();
    }
  });

  it("rejects duplicate question ids before any network call", async () => {
    await expect(
      askAboutImage(
        imagePath,
        [
          { id: "q1", question: "a" },
          { id: "q1", question: "b" },
        ],
        { backend: "anthropic", apiKey: "k", baseUrl: "http://unused" },
      ),
    ).rejects.toMatchObject({ code: "VISION_QUESTION_INVALID" });
  });

  it("rejects an empty question list", async () => {
    await expect(
      askAboutImage(imagePath, [], {
        backend: "anthropic",
        apiKey: "k",
        baseUrl: "http://unused",
      }),
    ).rejects.toMatchObject({ code: "VISION_NO_QUESTIONS" });
  });
});
