import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FileJobQueue } from "./file-queue.ts";
import { createWorkerState, DEFAULT_LIMITS } from "./state.ts";
import { processJob } from "./worker.ts";

it("aborts timed-out analysis and publishes a failure without creating scratch analysis", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "queue-timeout-"));
  try {
    const queue = new FileJobQueue(root);
    queue.enqueue("/image.png", "ocr.cancellable", {
      artifact: "image.png",
      kind: "screenshot",
      analysisPath: null,
    });
    const claimed = queue.claim();
    if (!claimed) throw new Error("missing job");
    let aborted = false;
    const outcome = await processJob(
      claimed,
      {
        queue,
        tier: "gpu",
        now: Date.now,
        limits: { ...DEFAULT_LIMITS, jobTimeoutMs: 20 },
        analyzers: [
          {
            name: "ocr.cancellable",
            tier: "gpu",
            kinds: ["screenshot"],
            analyze: (_input, ctx) =>
              new Promise((_resolve, reject) => {
                ctx.signal?.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(ctx.signal?.reason);
                  },
                  { once: true },
                );
              }),
          },
        ],
      },
      createWorkerState(),
    );
    expect(aborted).toBe(true);
    expect(outcome.action).toBe("failed");
    expect(queue.readResult(claimed.job.id)?.status).toBe("failed");
    expect(readdirSync(root).sort()).toEqual([
      "done",
      "pending",
      "processing",
      "results",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
