// Filesystem job queue over a directory tree. Covers the enqueue → claim →
// complete lifecycle, backpressure refusal, poison-job handling (a malformed
// pending file becomes a failed result and the claim advances), unclaim/requeue,
// and — the load-bearing property — the atomic-rename claim under REAL
// concurrency: several separate OS processes drain one shared queue and every
// job is claimed by exactly one of them, never twice and never lost.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileJobQueue } from "./file-queue.ts";
import { QueueBackpressureError } from "./state.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-file-queue-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function newRoot(): string {
  const root = path.join(scratch, `q${counter++}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function enqueueParams(name: string) {
  return {
    artifact: `visual/x/${name}.png`,
    kind: "screenshot" as const,
    analysisPath: path.join(scratch, `${name}.analysis.json`),
  };
}

describe("FileJobQueue lifecycle", () => {
  it("enqueues, claims oldest-first, completes, and reads the result", () => {
    let clock = 1_000;
    const queue = new FileJobQueue(newRoot(), {
      now: () => clock,
      entropy: () => "e",
    });
    queue.enqueue("/abs/a.png", "ocr.unlimited", enqueueParams("a"));
    clock = 2_000;
    queue.enqueue("/abs/b.png", "ocr.unlimited", enqueueParams("b"));
    expect(queue.pendingCount()).toBe(2);

    const first = queue.claim();
    expect(first?.job.artifact).toBe("visual/x/a.png");
    if (!first) throw new Error("expected a claim");
    expect(queue.pendingCount()).toBe(1);

    queue.complete(first, {
      schema: 1,
      id: first.job.id,
      analyzerId: first.job.analyzerId,
      status: "completed",
      completedAt: new Date().toISOString(),
      analyzer: { status: "ran", durationMs: 3, data: { text: "hi" } },
    });
    const record = queue.readResult(first.job.id);
    expect(record?.status).toBe("completed");
    expect(record?.analyzer?.status).toBe("ran");
  });

  it("returns null when nothing is pending", () => {
    const queue = new FileJobQueue(newRoot());
    expect(queue.claim()).toBeNull();
  });

  it("refuses enqueue with a typed error at the backpressure cap", () => {
    const queue = new FileJobQueue(newRoot(), { maxPending: 2 });
    queue.enqueue("/abs/a.png", "ocr.unlimited", enqueueParams("a"));
    queue.enqueue("/abs/b.png", "ocr.unlimited", enqueueParams("b"));
    expect(() =>
      queue.enqueue("/abs/c.png", "ocr.unlimited", enqueueParams("c")),
    ).toThrow(QueueBackpressureError);
    expect(queue.pendingCount()).toBe(2);
  });

  it("turns a poison job into a failed result and keeps draining", () => {
    const root = newRoot();
    const queue = new FileJobQueue(root);
    // A malformed pending file; the all-digit early id sorts ahead of the good
    // job's real-time id so a single claim() hits the poison first.
    fs.writeFileSync(
      path.join(root, "pending", "20200101000000000-bad.json"),
      "{ not valid json",
    );
    queue.enqueue("/abs/good.png", "ocr.unlimited", enqueueParams("good"));

    const claimed = queue.claim();
    // The poison job was consumed (failed) first; the next claim is the good one.
    expect(claimed?.job.artifact).toBe("visual/x/good.png");
    const badResult = queue.readResult("20200101000000000-bad");
    expect(badResult?.status).toBe("failed");
    expect(badResult?.reason).toMatch(/not valid JSON/);
  });

  it("unclaim returns a job to pending for retry", () => {
    const queue = new FileJobQueue(newRoot());
    queue.enqueue("/abs/a.png", "ocr.unlimited", enqueueParams("a"));
    const claimed = queue.claim();
    if (!claimed) throw new Error("expected a claim");
    expect(queue.pendingCount()).toBe(0);
    queue.unclaim(claimed);
    expect(queue.pendingCount()).toBe(1);
    expect(queue.claim()?.job.artifact).toBe("visual/x/a.png");
  });
});

describe("atomic claim under real multi-process concurrency", () => {
  const childScript = path.join(scratch, "claim-child.mjs");
  const fileQueueSrc = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "file-queue.ts",
  );

  beforeAll(() => {
    // A standalone claimer: drains the shared queue and prints each claimed id.
    // Run as a separate OS process so the rename-claim races for real, not on a
    // single JS thread where sequential renames could never collide.
    fs.writeFileSync(
      childScript,
      `import { FileJobQueue } from ${JSON.stringify(fileQueueSrc)};
const queue = new FileJobQueue(process.argv[2]);
const claimed = [];
for (;;) {
  const job = queue.claim();
  if (!job) break;
  claimed.push(job.job.id);
  queue.complete(job, {
    schema: 1, id: job.job.id, analyzerId: job.job.analyzerId,
    status: "completed", completedAt: new Date().toISOString(),
    analyzer: { status: "ran", durationMs: 0, data: {} },
  });
}
process.stdout.write(claimed.join("\\n"));
`,
    );
  });

  it("claims every job exactly once across 4 racing processes", async () => {
    const root = newRoot();
    const queue = new FileJobQueue(root);
    const total = 120;
    const enqueued = new Set<string>();
    for (let i = 0; i < total; i++) {
      const job = queue.enqueue(
        `/abs/${i}.png`,
        "ocr.unlimited",
        enqueueParams(`img${i}`),
      );
      enqueued.add(job.id);
    }

    // Launch all drainers CONCURRENTLY against the one shared directory (async
    // spawn, not spawnSync — the whole point is that four processes race the
    // same renames at once). Run under `bun` so the child can import the `.ts`
    // queue module directly; bun is the repo's pinned runtime.
    const drain = (): Promise<string[]> =>
      new Promise((resolve, reject) => {
        const child = spawn("bun", [childScript, root]);
        let out = "";
        child.stdout.on("data", (c) => {
          out += String(c);
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(out.split("\n").filter((l) => l.trim()))
            : reject(new Error(`child exited ${code}`)),
        );
      });

    const results = await Promise.all([drain(), drain(), drain(), drain()]);
    const claimedAll = results.flat();

    // Exactly-once: no id claimed twice, and every enqueued id was claimed.
    expect(claimedAll.length).toBe(total);
    expect(new Set(claimedAll).size).toBe(total);
    expect(new Set(claimedAll)).toEqual(enqueued);
    expect(queue.pendingCount()).toBe(0);
  });
});
