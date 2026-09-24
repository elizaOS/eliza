/**
 * askBatch tests: results preserve input order over concurrent workers, the
 * concurrency limit is respected (never more than N in flight), and a single
 * entry's failure rejects the whole batch rather than silently dropping it.
 */

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askBatch } from "./ask.ts";
import type { BatchEntry } from "./types.ts";

function answersFor(ids: string[]): string {
  return JSON.stringify({
    answers: ids.map((id) => ({
      id,
      answer: "a",
      confidence: 1,
      details: "d",
    })),
  });
}

/** Stub that tracks max concurrent in-flight requests and adds a small delay. */
function startStub(): Promise<{
  server: Server;
  url: string;
  maxInFlight: () => number;
}> {
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer((req, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text: string = body.messages[0].content.find(
        (b: { type: string }) => b.type === "text",
      ).text;
      const ids = [...text.matchAll(/id "([^"]+)"/g)].map((m) => m[1]);
      setTimeout(() => {
        inFlight -= 1;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: answersFor(ids) }],
            usage: { input_tokens: 100, output_tokens: 5 },
          }),
        );
      }, 25);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1`,
        maxInFlight: () => maxInFlight,
      });
    });
  });
}

let dir: string;
const images: string[] = [];
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-batch-"));
  images.length = 0;
  for (let i = 0; i < 6; i += 1) {
    const file = path.join(dir, `shot-${i}.png`);
    // Distinct sizes → distinct bytes → distinct cache keys per image.
    await sharp({
      create: { width: 100 + i, height: 80, channels: 3, background: "#222" },
    })
      .png()
      .toFile(file);
    images.push(file);
  }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("askBatch", () => {
  it("preserves input order and honors the concurrency limit", async () => {
    const { server, url, maxInFlight } = await startStub();
    const entries: BatchEntry[] = images.map((imagePath, i) => ({
      imagePath,
      questions: [{ id: `only-${i}`, question: "q?" }],
    }));
    try {
      const results = await askBatch(entries, {
        backend: "anthropic",
        apiKey: "k",
        baseUrl: url,
        noCache: true,
        concurrency: 2,
      });
      expect(results.map((r) => r.imagePath)).toEqual(images);
      expect(results[0].result.answers[0].id).toBe("only-0");
      expect(maxInFlight()).toBeLessThanOrEqual(2);
    } finally {
      server.close();
    }
  });

  it("rejects the whole batch when one entry's image is missing", async () => {
    const { server, url } = await startStub();
    const entries: BatchEntry[] = [
      { imagePath: images[0], questions: [{ id: "a", question: "q?" }] },
      {
        imagePath: path.join(dir, "does-not-exist.png"),
        questions: [{ id: "b", question: "q?" }],
      },
    ];
    try {
      await expect(
        askBatch(entries, {
          backend: "anthropic",
          apiKey: "k",
          baseUrl: url,
          noCache: true,
          concurrency: 2,
        }),
      ).rejects.toMatchObject({ code: "VISION_IMAGE_UNREADABLE" });
    } finally {
      server.close();
    }
  });
});
