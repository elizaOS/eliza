import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostWorker, transcribe } from "./host-wer-gate";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A fake worker that speaks the fd-3 protocol: echoes text, errors on "fail". */
function fakeWorker(): string[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-gate-worker-"));
  dirs.push(dir);
  const file = path.join(dir, "worker.ts");
  writeFileSync(
    file,
    `import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
const emit = (v) => writeSync(3, JSON.stringify(v) + "\\n");
console.log("diagnostic on stdout");
emit({ ready: true });
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.op === "transcribe") {
    const pcm = Buffer.from(req.pcm, "base64");
    if (req.encoding !== "f32" || req.sampleRate !== 16000 || pcm.length !== 12 ||
        pcm.readFloatLE(0) !== -0.5 || pcm.readFloatLE(4) !== 0 || pcm.readFloatLE(8) !== 0.5)
      emit({ id: req.id, error: "invalid_transcription_protocol" });
    else emit({ id: req.id, text: "recognized" });
  }
  else if (req.text === "fail") emit({ id: req.id, error: "synthesis_failed" });
  else emit({ id: req.id, text: String(req.text).toUpperCase() });
}
`,
  );
  return [process.execPath, file];
}

describe("host worker protocol", () => {
  it("waits for ready, matches replies by id and surfaces worker errors", async () => {
    const log = path.join(
      mkdtempSync(path.join(os.tmpdir(), "voice-gate-log-")),
      "w.log",
    );
    dirs.push(path.dirname(log));
    const worker = new HostWorker("fake", fakeWorker(), log, 30_000);
    try {
      await worker.waitReady();
      const [a, b] = await Promise.all([
        worker.request({ text: "one" }),
        worker.request({ text: "two" }),
      ]);
      expect(
        (await transcribe(worker, new Float32Array([-0.5, 0, 0.5]))).text,
      ).toBe("recognized");
      expect(a.text).toBe("ONE");
      expect(b.text).toBe("TWO");
      await expect(worker.request({ text: "fail" })).rejects.toThrow(
        "fake: synthesis_failed",
      );
    } finally {
      worker.close();
    }
  });

  it("rejects pending work when the worker exits", async () => {
    const log = path.join(
      mkdtempSync(path.join(os.tmpdir(), "voice-gate-log-")),
      "w.log",
    );
    dirs.push(path.dirname(log));
    const worker = new HostWorker(
      "dead",
      [process.execPath, "-e", "process.exit(3)"],
      log,
      30_000,
    );
    await expect(worker.waitReady()).rejects.toThrow(/exited \(code 3/);
  });
});
