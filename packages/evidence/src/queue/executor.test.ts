// The QueueExecutor seam that lets the analyzer runner offload gpu-tier work to
// the queue. Three properties: cpu-tier and above-tier analyzers are delegated
// to the inline executor unchanged; a gpu-tier analyzer is enqueued and its
// worker-produced result handed back (proven by running a worker concurrently
// against a stub); and when NO worker consumes the job within the timeout the
// executor returns an honest `skipped-missing-tool` naming the missing worker —
// never a fabricated result.

import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UnlimitedOcrEngine } from "../analyzers/ocr/engines.ts";
import { makeOcrAnalyzer } from "../analyzers/ocr/ocr.ts";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerInput,
} from "../analyzers/types.ts";
import { QueueExecutor } from "./executor.ts";
import { FileJobQueue } from "./file-queue.ts";
import { runQueueWorker } from "./worker.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-queue-exec-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function newRoot(): string {
  const root = path.join(scratch, `q${n++}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function writePng(file: string): string {
  fs.writeFileSync(
    file,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  return file;
}

function inputFor(absolutePath: string): AnalyzerInput {
  return {
    entry: {
      path: "visual/login/desktop/shot.png",
      sha256: "0".repeat(64),
      bytes: 0,
      kind: "screenshot",
      source: "test",
      producedBy: "test",
      createdAt: new Date().toISOString(),
    },
    absolutePath,
  };
}

function startStub(content: string) {
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.writeHead(200).end("ok");
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      req.resume(); // drain the request body; the stub does not inspect it
      req.on("end", () =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ choices: [{ message: { content } }] })),
      );
      return;
    }
    res.writeHead(404).end();
  });
  const started = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  return { server, started };
}

const gpuCtx: AnalyzerContext = { tier: "gpu" };

describe("QueueExecutor routing", () => {
  it("delegates a cpu-tier analyzer to the inline executor (does not enqueue)", async () => {
    const queue = new FileJobQueue(newRoot());
    const executor = new QueueExecutor(queue);
    const cpu: Analyzer = {
      name: "noop.cpu",
      tier: "cpu",
      kinds: ["screenshot"],
      analyze: () => ({ status: "ran", data: { ok: true } }),
    };
    const result = await executor.execute(
      cpu,
      inputFor(writePng(path.join(scratch, "c.png"))),
      gpuCtx,
    );
    expect(result.status).toBe("ran");
    expect(queue.pendingCount()).toBe(0); // never queued
  });

  it("delegates an above-tier gpu analyzer to inline (records skipped-tier) at cpu tier", async () => {
    const queue = new FileJobQueue(newRoot());
    const executor = new QueueExecutor(queue);
    const gpu = makeOcrAnalyzer(
      new UnlimitedOcrEngine({ baseUrl: undefined }),
      "gpu",
    );
    const result = await executor.execute(
      gpu,
      inputFor(writePng(path.join(scratch, "g.png"))),
      { tier: "cpu" },
    );
    expect(result.status).toBe("skipped-tier");
    expect(queue.pendingCount()).toBe(0);
  });
});

describe("QueueExecutor end-to-end through a worker", () => {
  it("enqueues a gpu analyzer and returns the worker's merged result", async () => {
    const stub = startStub("# Login\nSign in to Eliza");
    const baseUrl = await stub.started;
    try {
      const queue = new FileJobQueue(newRoot());
      const executor = new QueueExecutor(queue, {
        pollMs: 20,
        resultTimeoutMs: 10_000,
      });
      const gpu = makeOcrAnalyzer(new UnlimitedOcrEngine({ baseUrl }), "gpu");
      const input = inputFor(writePng(path.join(scratch, "e.png")));

      // Run the executor and a worker CONCURRENTLY: the executor enqueues and
      // polls for the result the worker produces.
      const [result] = await Promise.all([
        executor.execute(gpu, input, gpuCtx),
        runQueueWorker({
          queue,
          analyzers: [gpu],
          tier: "gpu",
          stopWhenIdle: true,
          limits: { pollMs: 20 },
        }),
      ]);
      expect(result.status).toBe("ran");
      if (result.status === "ran") {
        expect((result.data as { text: string }).text).toContain(
          "Sign in to Eliza",
        );
      }
    } finally {
      stub.server.close();
    }
  });

  it("returns an honest skip when no worker produces a result in time", async () => {
    const queue = new FileJobQueue(newRoot());
    const executor = new QueueExecutor(queue, {
      pollMs: 10,
      resultTimeoutMs: 60,
    });
    const gpu = makeOcrAnalyzer(
      new UnlimitedOcrEngine({ baseUrl: undefined }),
      "gpu",
    );
    const result = await executor.execute(
      gpu,
      inputFor(writePng(path.join(scratch, "s.png"))),
      gpuCtx,
    );
    expect(result.status).toBe("skipped-missing-tool");
    expect(result.reason).toMatch(/no gpu queue worker/);
    expect("data" in result).toBe(false);
    // The job stays enqueued for a worker that may still attach.
    expect(queue.pendingCount()).toBe(1);
  });
});
