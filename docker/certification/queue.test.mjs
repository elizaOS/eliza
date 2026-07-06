/**
 * Tests for the GPU job queue (#14549): the pure state machine in
 * queue-lib.mjs (job validation, claim order, backpressure, unreachable→drain
 * transitions, result records), and the real worker process end-to-end — a
 * spawned queue-worker.mjs consuming a temp jobs dir against a live in-test
 * HTTP stub standing in for the llama-server endpoint (the GPU model itself is
 * exercised on the owner-gated Linux acceptance run), including the
 * drain-to-skip path against an unreachable port. Run with
 * `bun test docker/certification`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimOrder,
  createWorkerState,
  decideEnqueue,
  IMAGE_PLACEHOLDER,
  makeJobId,
  onServiceOk,
  onServiceUnreachable,
  parseJob,
  QueueJobInvalidError,
  resolveImagePlaceholders,
  resultRecord,
  shouldSkipJob,
} from "./queue-lib.mjs";
import { enqueueJob, QueueBackpressureError } from "./queue-worker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "queue-worker.mjs");

describe("parseJob", () => {
  const models = ["ocr", "vlm"];
  test("accepts a well-formed job", () => {
    const job = parseJob(
      JSON.stringify({ id: "a-1", model: "ocr", request: { messages: [] } }),
      models,
    );
    expect(job.id).toBe("a-1");
  });

  test("rejects malformed JSON, missing fields, unknown models, unsafe paths", () => {
    expect(() => parseJob("{nope", models)).toThrow(QueueJobInvalidError);
    expect(() => parseJob('"str"', models)).toThrow(/not an object/);
    expect(() => parseJob("{}", models)).toThrow(/missing id/);
    expect(() =>
      parseJob(
        JSON.stringify({ id: "a/../b", model: "ocr", request: {} }),
        models,
      ),
    ).toThrow(/unsafe characters/);
    expect(() =>
      parseJob(JSON.stringify({ id: "a", model: "nope", request: {} }), models),
    ).toThrow(/model must be one of ocr\|vlm/);
    expect(() =>
      parseJob(JSON.stringify({ id: "a", model: "ocr" }), models),
    ).toThrow(/missing request/);
    expect(() =>
      parseJob(
        JSON.stringify({
          id: "a",
          model: "ocr",
          request: {},
          imagePath: "../etc/passwd",
        }),
        models,
      ),
    ).toThrow(/without \.\./);
    expect(() =>
      parseJob(
        JSON.stringify({
          id: "a",
          model: "ocr",
          request: {},
          imagePath: "/abs",
        }),
        models,
      ),
    ).toThrow(/relative/);
  });
});

describe("claim order and ids", () => {
  test("claims oldest-first by timestamp-prefixed id, json files only", () => {
    const names = [
      "20260706T2-b.json",
      "20260706T1-a.json",
      "junk.tmp",
      "20260706T3-c.json",
    ];
    expect(claimOrder(names)).toEqual([
      "20260706T1-a.json",
      "20260706T2-b.json",
      "20260706T3-c.json",
    ]);
  });

  test("makeJobId sorts by enqueue time", () => {
    const early = makeJobId(Date.UTC(2026, 6, 6, 10, 0, 0), "aaa");
    const late = makeJobId(Date.UTC(2026, 6, 6, 10, 0, 1), "aaa");
    expect(early < late).toBe(true);
    expect(early).toMatch(/^[0-9]+-aaa$/);
  });
});

describe("backpressure", () => {
  test("accepts under the cap, refuses at the cap with a reason", () => {
    expect(decideEnqueue(0, 2)).toEqual({ accept: true });
    expect(decideEnqueue(1, 2)).toEqual({ accept: true });
    expect(decideEnqueue(2, 2).accept).toBe(false);
    expect(decideEnqueue(2, 2).reason).toMatch(/2 pending >= max 2/);
  });
});

describe("unreachable → drain state machine", () => {
  test("stamps the outage start, drains only past the window, resets on contact", () => {
    const drainAfterMs = 1000;
    let state = createWorkerState();
    expect(shouldSkipJob(state)).toBe(false);

    state = onServiceUnreachable(state, 10_000, drainAfterMs);
    expect(state.unreachableSince).toBe(10_000);
    expect(state.draining).toBe(false);

    state = onServiceUnreachable(state, 10_500, drainAfterMs);
    expect(state.unreachableSince).toBe(10_000); // outage start is preserved
    expect(state.draining).toBe(false);

    state = onServiceUnreachable(state, 11_000, drainAfterMs);
    expect(state.draining).toBe(true);
    expect(shouldSkipJob(state)).toBe(true);

    // Draining latches until the service actually answers again.
    state = onServiceUnreachable(state, 11_001, drainAfterMs);
    expect(state.draining).toBe(true);

    state = onServiceOk();
    expect(state).toEqual({ unreachableSince: null, draining: false });
  });
});

describe("resultRecord", () => {
  const job = { id: "j1", model: "ocr" };
  test("ok carries duration + response; failed/skipped carry a reason", () => {
    const ok = resultRecord(
      job,
      { status: "ok", durationMs: 42, response: { x: 1 } },
      "t",
    );
    expect(ok).toEqual({
      schema: 1,
      id: "j1",
      model: "ocr",
      status: "ok",
      completedAt: "t",
      durationMs: 42,
      response: { x: 1 },
    });
    const skipped = resultRecord(
      job,
      { status: "skipped", reason: "drained" },
      "t",
    );
    expect(skipped.reason).toBe("drained");
    expect(skipped.response).toBeUndefined();
    expect(() => resultRecord(job, { status: "wat" }, "t")).toThrow(
      /unknown outcome/,
    );
  });
});

describe("resolveImagePlaceholders", () => {
  test("replaces only the placeholder url, without mutating the input", () => {
    const request = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: IMAGE_PLACEHOLDER } },
            { type: "text", text: `keep ${IMAGE_PLACEHOLDER} in text` },
            { type: "image_url", image_url: { url: "data:already/inline" } },
          ],
        },
      ],
    };
    const resolved = resolveImagePlaceholders(
      request,
      "data:image/png;base64,AA==",
    );
    expect(resolved.messages[0].content[0].image_url.url).toBe(
      "data:image/png;base64,AA==",
    );
    expect(resolved.messages[0].content[1].text).toContain(IMAGE_PLACEHOLDER);
    expect(resolved.messages[0].content[2].image_url.url).toBe(
      "data:already/inline",
    );
    expect(request.messages[0].content[0].image_url.url).toBe(
      IMAGE_PLACEHOLDER,
    );
  });
});

/** Spawn the real worker in --once mode and wait for exit. */
function runWorkerOnce(jobsRoot, serviceUrl, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        workerPath,
        "--jobs",
        jobsRoot,
        "--service",
        `ocr=${serviceUrl}`,
        "--service",
        `vlm=${serviceUrl}`,
        "--poll-ms",
        "50",
        "--once",
        ...extraArgs,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("worker end-to-end (real process, stub llama-server)", () => {
  let server;
  let baseUrl;
  const seen = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        seen.push({ url: req.url, body: parsed });
        if (parsed.messages?.[0]?.content === "explode") {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("kaboom");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "stub-answer" } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
        );
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => {
    server.close();
  });

  test("consumes enqueued jobs, calls the service, writes ok/failed results beside them", async () => {
    const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-queue-"));
    const okId = await enqueueJob(jobsRoot, {
      model: "ocr",
      request: { messages: [{ role: "user", content: "read this" }] },
    });
    const failId = await enqueueJob(jobsRoot, {
      model: "vlm",
      request: { messages: [{ role: "user", content: "explode" }] },
    });
    // Invalid job file dropped straight into pending/ (bypasses enqueueJob).
    await fs.writeFile(
      path.join(jobsRoot, "pending", "zzz-invalid.json"),
      "{nope",
      "utf8",
    );

    const { code, stderr } = await runWorkerOnce(jobsRoot, baseUrl);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const okResult = JSON.parse(
      await fs.readFile(path.join(jobsRoot, "results", `${okId}.json`), "utf8"),
    );
    expect(okResult.status).toBe("ok");
    expect(okResult.response.choices[0].message.content).toBe("stub-answer");
    expect(okResult.durationMs).toBeGreaterThanOrEqual(0);

    const failResult = JSON.parse(
      await fs.readFile(
        path.join(jobsRoot, "results", `${failId}.json`),
        "utf8",
      ),
    );
    expect(failResult.status).toBe("failed");
    expect(failResult.reason).toMatch(/http 500: kaboom/);

    const invalidResult = JSON.parse(
      await fs.readFile(
        path.join(jobsRoot, "results", "zzz-invalid.json"),
        "utf8",
      ),
    );
    expect(invalidResult.status).toBe("failed");
    expect(invalidResult.reason).toMatch(/not valid JSON/);

    // Consumed jobs moved to done/, pending drained.
    expect((await fs.readdir(path.join(jobsRoot, "pending"))).length).toBe(0);
    expect((await fs.readdir(path.join(jobsRoot, "done"))).sort().length).toBe(
      3,
    );
    await fs.rm(jobsRoot, { recursive: true, force: true });
  }, 30_000);

  test("inlines imagePath as a data URI at the queue:image placeholder", async () => {
    const jobsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-queue-img-"),
    );
    await fs.mkdir(path.join(jobsRoot, "images"), { recursive: true });
    // 1x1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(path.join(jobsRoot, "images", "shot.png"), png);
    seen.length = 0;
    const id = await enqueueJob(jobsRoot, {
      model: "ocr",
      imagePath: "images/shot.png",
      request: {
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: IMAGE_PLACEHOLDER } },
            ],
          },
        ],
      },
    });
    const { code } = await runWorkerOnce(jobsRoot, baseUrl);
    expect(code).toBe(0);
    const result = JSON.parse(
      await fs.readFile(path.join(jobsRoot, "results", `${id}.json`), "utf8"),
    );
    expect(result.status).toBe("ok");
    const sent = seen[0].body.messages[0].content[0].image_url.url;
    expect(sent).toBe(`data:image/png;base64,${png.toString("base64")}`);
    await fs.rm(jobsRoot, { recursive: true, force: true });
  }, 30_000);

  test("enqueueJob applies max-pending backpressure", async () => {
    const jobsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-queue-bp-"),
    );
    const limits = { maxPending: 2 };
    await enqueueJob(jobsRoot, { model: "ocr", request: {} }, limits);
    await enqueueJob(jobsRoot, { model: "ocr", request: {} }, limits);
    await expect(
      enqueueJob(jobsRoot, { model: "ocr", request: {} }, limits),
    ).rejects.toThrow(QueueBackpressureError);
    await fs.rm(jobsRoot, { recursive: true, force: true });
  });
});

describe("worker drain-to-skip (unreachable service, real process)", () => {
  test("past the drain window every pending job becomes an honest skipped record", async () => {
    const jobsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-queue-drain-"),
    );
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await enqueueJob(jobsRoot, { model: "ocr", request: { messages: [] } }),
      );
    }
    // Port 1 on localhost: connection refused immediately, nobody listens.
    const { code } = await runWorkerOnce(jobsRoot, "http://127.0.0.1:1", [
      "--drain-after-ms",
      "300",
      "--request-timeout-ms",
      "500",
    ]);
    expect(code).toBe(0);
    for (const id of ids) {
      const result = JSON.parse(
        await fs.readFile(path.join(jobsRoot, "results", `${id}.json`), "utf8"),
      );
      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/unreachable past 300ms — drained/);
    }
    expect((await fs.readdir(path.join(jobsRoot, "pending"))).length).toBe(0);
    await fs.rm(jobsRoot, { recursive: true, force: true });
  }, 30_000);
});
