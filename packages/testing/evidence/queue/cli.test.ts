/** Exercises queue CLI outcomes against actual files, including invalid jobs and unavailable analyzers. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runQueueCli } from "./cli.ts";
import { FileJobQueue } from "./file-queue.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-queue-cli-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function newRoot(): string {
  const root = path.join(scratch, `q${n++}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
}

describe("runQueueCli", () => {
  it("reports newly retired invalid jobs and exits nonzero without recounting historical failures", async () => {
    const root = newRoot();
    const queue = new FileJobQueue(root);
    fs.writeFileSync(
      path.join(root, "pending", "000-invalid.json"),
      "{not JSON",
    );
    const first = captureIo();
    expect(
      await runQueueCli(["worker", "--root", root, "--once"], first.io),
    ).toBe(1);
    const result = queue.readResult("000-invalid");
    expect(result).toMatchObject({ status: "failed", id: "000-invalid" });
    expect(result?.reason).toBeTruthy();
    expect(first.out.join("\n")).toContain(
      "0 completed, 1 failed, 0 skipped, 0 requeued",
    );
    expect(fs.existsSync(path.join(root, "done", "000-invalid.json"))).toBe(
      true,
    );
    const second = captureIo();
    expect(
      await runQueueCli(["worker", "--root", root, "--once"], second.io),
    ).toBe(0);
    expect(second.out.join("\n")).toContain(
      "0 completed, 0 failed, 0 skipped, 0 requeued",
    );
    expect(queue.readResult("000-invalid")).toEqual(result);
  });

  it("prints usage and exits 1 on an unknown command", async () => {
    const { io, err } = captureIo();
    expect(await runQueueCli(["bogus"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/Usage:/);
  });

  it("exits 1 with a structured error on a missing required flag", async () => {
    const { io, err } = captureIo();
    expect(await runQueueCli(["enqueue", "--root", newRoot()], io)).toBe(1);
    expect(err.join("\n")).toMatch(/missing required --image/);
  });

  it("rejects a non-image artifact kind before enqueueing", async () => {
    const root = newRoot();
    const img = path.join(root, "shot.png");
    fs.writeFileSync(img, "not-a-real-png");

    const { io, err } = captureIo();
    const code = await runQueueCli(
      [
        "enqueue",
        "--root",
        root,
        "--image",
        img,
        "--analyzer",
        "ocr.unlimited",
        "--artifact",
        "reports/out.json",
        "--analysis",
        path.join(root, "out.analysis.json"),
        "--kind",
        "report",
      ],
      io,
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/--kind must be screenshot or keyframe/);
    expect(new FileJobQueue(root).pendingCount()).toBe(0);
  });

  it("enqueues a job that then drains to a skip with no service (--once)", async () => {
    const root = newRoot();
    const analysisPath = path.join(root, "shot.png.analysis.json");
    const img = path.join(root, "shot.png");
    fs.writeFileSync(img, "not-a-real-png");

    const enqueue = captureIo();
    const enqueueCode = await runQueueCli(
      [
        "enqueue",
        "--root",
        root,
        "--image",
        img,
        "--analyzer",
        "ocr.unlimited",
        "--artifact",
        "visual/x/shot.png",
        "--analysis",
        analysisPath,
      ],
      enqueue.io,
    );
    expect(enqueueCode).toBe(0);
    expect(enqueue.out.join("\n")).toMatch(/enqueued/);
    expect(new FileJobQueue(root).pendingCount()).toBe(1);

    // Worker with a 0ms drain window: the unset endpoint is unreachable, so the
    // job is drained to a skip immediately and the run ends (--once).
    const worker = captureIo();
    const workerCode = await runQueueCli(
      ["worker", "--root", root, "--once", "--drain-after-ms", "0"],
      worker.io,
    );
    expect(workerCode).toBe(0);
    expect(worker.out.join("\n")).toMatch(/skipped 1|1 skipped/);

    const doc = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    expect(doc.results["ocr.unlimited"].status).toBe("skipped-missing-tool");
    expect("data" in doc.results["ocr.unlimited"]).toBe(false);
  });
});
