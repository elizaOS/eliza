// The GPU queue worker driven end-to-end against a LOCAL HTTP stub standing in
// for the llama-server: a reachable stub proves a real screenshot flows
// enqueue → claim → OCR request → result merged into analysis.json (with the
// pinned prompt and image data URL asserted on the wire). The unreachable and
// drain paths prove the honesty contract — a down service yields a `skipped`
// job result and a `skipped-missing-tool` analysis record naming why, NEVER a
// fabricated empty transcript. No GPU, no model: just a Node http server.

import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UnlimitedOcrEngine } from "../analyzers/ocr/engines.ts";
import { makeOcrAnalyzer } from "../analyzers/ocr/ocr.ts";
import type { Analyzer } from "../analyzers/types.ts";
import { FileJobQueue } from "./file-queue.ts";
import { DEFAULT_LIMITS, type WorkerState } from "./state.ts";
import { processJob, runQueueWorker } from "./worker.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-worker-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function newRoot(): string {
  const root = path.join(scratch, `q${n++}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Minimal 1x1 PNG so the engine has real bytes to base64 into the request. */
function writePng(file: string): string {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(file, png);
  return file;
}

/** Stub llama-server: /health + OpenAI-compatible /v1/chat/completions. */
function startStub(content: () => string) {
  const requests: { url: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        requests.push({ url: req.url as string, body: JSON.parse(raw) });
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({ choices: [{ message: { content: content() } }] }),
          );
      });
      return;
    }
    res.writeHead(404).end();
  });
  const started = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  return { server, started, requests };
}

/** Build an ocr.unlimited analyzer bound to an explicit stub base URL. */
function unlimitedAt(baseUrl: string | undefined): Analyzer {
  return makeOcrAnalyzer(new UnlimitedOcrEngine({ baseUrl }), "gpu");
}

function enqueueOne(
  queue: FileJobQueue,
  imagePath: string,
  analysisPath: string,
) {
  return queue.enqueue(imagePath, "ocr.unlimited", {
    artifact: "visual/login/desktop/shot.png",
    kind: "screenshot",
    analysisPath,
  });
}

describe("queue worker against a reachable stub", () => {
  it("runs the OCR job and merges the transcript into analysis.json", async () => {
    const stub = startStub(() => "# Login\nSign in to Eliza");
    const baseUrl = await stub.started;
    try {
      const root = newRoot();
      const queue = new FileJobQueue(root);
      const img = writePng(path.join(root, "shot.png"));
      const analysisPath = path.join(root, "shot.png.analysis.json");
      const job = enqueueOne(queue, img, analysisPath);

      const counts = await runQueueWorker({
        queue,
        analyzers: [unlimitedAt(baseUrl)],
        tier: "gpu",
        stopWhenIdle: true,
      });
      expect(counts.completed).toBe(1);

      // The result flowed into analysis.json under the analyzer name.
      const doc = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
      expect(doc.schema).toBe(1);
      const record = doc.results["ocr.unlimited"];
      expect(record.status).toBe("ran");
      expect(record.data.text).toContain("Sign in to Eliza");

      // The job result record is `completed` and carries the analyzer payload.
      const jobResult = queue.readResult(job.id);
      expect(jobResult?.status).toBe("completed");
      expect(jobResult?.analyzer?.status).toBe("ran");

      // The request on the wire was OpenAI-compatible: temperature 0, an image
      // data URL, and (proven elsewhere) the pinned prompt.
      const sent = stub.requests[0].body as {
        temperature: number;
        messages: {
          content: { type: string; image_url?: { url: string } }[];
        }[];
      };
      expect(sent.temperature).toBe(0);
      const parts = sent.messages[0].content;
      expect(parts.some((p) => p.type === "text")).toBe(true);
      const image = parts.find((p) => p.type === "image_url");
      expect(image?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    } finally {
      stub.server.close();
    }
  });
});

describe("queue worker with the service down (honest degradation)", () => {
  it("drains to a skipped record — never a fabricated transcript", async () => {
    const root = newRoot();
    const queue = new FileJobQueue(root);
    const img = writePng(path.join(root, "shot.png"));
    const analysisPath = path.join(root, "shot.png.analysis.json");
    const job = enqueueOne(queue, img, analysisPath);

    // Explicit-unset endpoint: the engine reports unavailable (no service),
    // which the worker classifies as a connectivity failure. drainAfterMs=0 so
    // the very first failure latches drain mode and the job is consumed as a skip.
    const counts = await runQueueWorker({
      queue,
      analyzers: [unlimitedAt(undefined)],
      tier: "gpu",
      stopWhenIdle: true,
      limits: { drainAfterMs: 0 },
    });
    expect(counts.skipped).toBe(1);
    expect(counts.completed).toBe(0);

    const jobResult = queue.readResult(job.id);
    expect(jobResult?.status).toBe("skipped");
    expect(jobResult?.reason).toBeTruthy();

    // analysis.json records skipped-missing-tool with a reason and NO data.
    const doc = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    const record = doc.results["ocr.unlimited"];
    expect(record.status).toBe("skipped-missing-tool");
    expect(record.reason).toBeTruthy();
    expect("data" in record).toBe(false);
  });

  it("requeues (does not consume) a transient failure before the drain window", async () => {
    const root = newRoot();
    const queue = new FileJobQueue(root);
    const img = writePng(path.join(root, "shot.png"));
    const analysisPath = path.join(root, "shot.png.analysis.json");
    enqueueOne(queue, img, analysisPath);

    // drainAfterMs huge → the first connectivity failure requeues rather than
    // skipping; stopWhenIdle returns after the requeue so the job survives in
    // pending for a later worker once the service returns.
    const counts = await runQueueWorker({
      queue,
      analyzers: [unlimitedAt(undefined)],
      tier: "gpu",
      stopWhenIdle: true,
      limits: { drainAfterMs: 10 * 60_000 },
    });
    expect(counts.requeued).toBe(1);
    expect(counts.skipped).toBe(0);
    // The job is back in pending, unconsumed — no analysis.json fabricated.
    expect(queue.pendingCount()).toBe(1);
    expect(fs.existsSync(analysisPath)).toBe(false);
  });
});

describe("queue worker recovers from a latched drain (liveness)", () => {
  it("processJob analyzes the job and clears the drain latch once the service is reachable again", async () => {
    const stub = startStub(() => "# Login\nSign in to Eliza");
    const baseUrl = await stub.started;
    try {
      const root = newRoot();
      const queue = new FileJobQueue(root);
      const img = writePng(path.join(root, "shot.png"));
      const analysisPath = path.join(root, "shot.png.analysis.json");
      enqueueOne(queue, img, analysisPath);
      const claimed = queue.claim();
      if (!claimed) throw new Error("expected to claim the enqueued job");

      // The worker is already latched into drain mode from a prior sustained
      // outage. With the service back up, processJob must re-probe (via the
      // analyzer's availability check), analyze for real, and reset the latch —
      // NOT skip blindly the way a permanent latch would.
      const draining: WorkerState = { unreachableSince: 1_000, draining: true };
      const outcome = await processJob(
        claimed,
        {
          queue,
          analyzers: [unlimitedAt(baseUrl)],
          tier: "gpu",
          limits: DEFAULT_LIMITS,
          now: () => 2_000,
        },
        draining,
      );

      expect(outcome.action).toBe("completed");
      expect(outcome.state.draining).toBe(false);
      expect(outcome.state.unreachableSince).toBeNull();
      const doc = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
      expect(doc.results["ocr.unlimited"].status).toBe("ran");
    } finally {
      stub.server.close();
    }
  });

  it("after an outage latches drain, the next job is PROCESSED once the service recovers", async () => {
    // /health is down on the FIRST probe (latches drain at drainAfterMs=0) then
    // recovers — the redeploy-outage a resident worker must survive. Before the
    // fix the latch was permanent and every subsequent job skipped forever.
    let healthProbes = 0;
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        healthProbes += 1;
        if (healthProbes === 1) {
          res.writeHead(503).end("service redeploying");
          return;
        }
        res.writeHead(200).end("ok");
        return;
      }
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.resume();
        req.on("end", () =>
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(
              JSON.stringify({ choices: [{ message: { content: "# Home" } }] }),
            ),
        );
        return;
      }
      res.writeHead(404).end();
    });
    const baseUrl = await new Promise<string>((resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    );
    try {
      const root = newRoot();
      const queue = new FileJobQueue(root);
      const a = writePng(path.join(root, "a.png"));
      const b = writePng(path.join(root, "b.png"));
      enqueueOne(queue, a, path.join(root, "a.png.analysis.json"));
      enqueueOne(queue, b, path.join(root, "b.png.analysis.json"));

      const counts = await runQueueWorker({
        queue,
        analyzers: [unlimitedAt(baseUrl)],
        tier: "gpu",
        stopWhenIdle: true,
        limits: { drainAfterMs: 0 },
      });

      // One job drained while the service was down; the other was analyzed for
      // real after recovery. The permanent-latch bug would have skipped both.
      expect(counts.skipped).toBe(1);
      expect(counts.completed).toBe(1);
      expect(healthProbes).toBeGreaterThanOrEqual(2);
    } finally {
      server.close();
    }
  });
});

describe("queue worker enforces a hard per-job timeout", () => {
  it("fails a job whose analyzer never returns", async () => {
    const root = newRoot();
    const queue = new FileJobQueue(root);
    const img = writePng(path.join(root, "shot.png"));
    const analysisPath = path.join(root, "shot.png.analysis.json");
    const job = queue.enqueue(img, "ocr.hang", {
      artifact: "visual/x/shot.png",
      kind: "screenshot",
      analysisPath,
    });

    const hang: Analyzer = {
      name: "ocr.hang",
      tier: "gpu",
      kinds: ["screenshot"],
      analyze: () => new Promise(() => {}), // never resolves
    };

    const counts = await runQueueWorker({
      queue,
      analyzers: [hang],
      tier: "gpu",
      stopWhenIdle: true,
      limits: { jobTimeoutMs: 40 },
    });
    expect(counts.failed).toBe(1);
    const jobResult = queue.readResult(job.id);
    expect(jobResult?.status).toBe("failed");
    expect(jobResult?.reason).toMatch(/hard timeout/);
  });
});
