/** Deterministic model-response and batch-cost regressions using real rasters and injected provider transport. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askBatch } from "./ask.ts";
import { parseAnswers } from "./backends.ts";
import {
  CliVisionBackend,
  type ProcessRunner,
  parseClaudeEnvelope,
} from "./cli-backend.ts";
import type { PreparedImage } from "./image.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const questions = [{ id: "q", question: "Is a button visible?" }];
const answer = { id: "q", answer: "yes", confidence: 0.8, details: "Visible" };
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-batch-"));
  dirs.push(dir);
  const images = [];
  for (let i = 0; i < 5; i++) {
    const file = path.join(dir, `${i}.png`);
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: i, g: 0, b: 0 },
      },
    })
      .png()
      .toFile(file);
    images.push(file);
  }
  return { dir, images };
}
const response = () =>
  Response.json({
    choices: [{ message: { content: JSON.stringify({ answers: [answer] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });

describe("model evidence boundaries", () => {
  it("rejects duplicate answers even when the set of ids matches", () => {
    expect(() =>
      parseAnswers(JSON.stringify({ answers: [answer, answer] }), questions),
    ).toThrow(/ids/);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid CLI usage %s",
    (input_tokens) => {
      expect(() =>
        parseClaudeEnvelope(
          JSON.stringify({
            result: "ok",
            usage: { input_tokens, output_tokens: 1 },
          }),
        ),
      ).toThrow(/safe integer/);
    },
  );
  it("passes an explicit model to the CLI instead of merely labeling its output", async () => {
    const runner = vi.fn<ProcessRunner>(async () => ({
      code: 0,
      stdout: JSON.stringify({
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      stderr: "",
    }));
    const client = new CliVisionBackend({
      cli: "claude",
      model: "test-model",
      runner,
    });
    const image: PreparedImage = {
      base64: "",
      mediaType: "image/png",
      sourceSha256: "a".repeat(64),
      dimensions: {
        originalWidth: 1,
        originalHeight: 1,
        sentWidth: 1,
        sentHeight: 1,
      },
    };
    await client.invoke(image, questions, null);
    expect(runner.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["--model", "test-model"]),
    );
  });
});

describe("askBatch", () => {
  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid concurrency %s before work",
    async (concurrency) => {
      await expect(askBatch([], { concurrency })).rejects.toThrow(
        /positive safe integer/,
      );
    },
  );
  it("coalesces identical pixels and questions without dropping artifact results", async () => {
    const { dir, images } = await fixture();
    fs.copyFileSync(images[0], images[1]);
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response();
    });
    const results = await askBatch(
      images.slice(0, 2).map((imagePath) => ({ imagePath, questions })),
      {
        backend: "openai",
        apiKey: "test",
        model: "fixture",
        cacheDir: dir,
        fetchImpl,
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.imagePath)).toEqual(
      images.slice(0, 2),
    );
    expect(
      results.filter((result) => result.result.provenance.cached),
    ).toHaveLength(1);
  });
  it("stops scheduling on failure and settles calls already started", async () => {
    const { dir, images } = await fixture();
    let active = 0;
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      const call = calls++;
      active++;
      try {
        await new Promise((resolve) =>
          setTimeout(resolve, call === 0 ? 10 : 40),
        );
        if (call === 0) throw new Error("provider failed");
        return response();
      } finally {
        active--;
      }
    });
    await expect(
      askBatch(
        images.map((imagePath) => ({ imagePath, questions })),
        {
          backend: "openai",
          apiKey: "test",
          cacheDir: dir,
          fetchImpl,
          concurrency: 2,
        },
      ),
    ).rejects.toThrow("provider failed");
    expect(calls).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });
});

it("separates cache entries across endpoints while reusing identical requests", async () => {
  const { dir, images } = await fixture();
  const fetchImpl = vi.fn(async () => response());
  const entry = [{ imagePath: images[0], questions }];
  const options = {
    backend: "openai" as const,
    apiKey: "test",
    model: "fixture",
    cacheDir: dir,
    fetchImpl,
  };
  await askBatch(entry, { ...options, baseUrl: "https://first.example/v1" });
  await askBatch(entry, { ...options, baseUrl: "https://second.example/v1" });
  const hit = await askBatch(entry, {
    ...options,
    baseUrl: "https://second.example/v1",
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(hit[0].result.provenance.cached).toBe(true);
});
