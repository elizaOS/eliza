import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  test,
  vi,
} from "vitest";
import { testOutputPath } from "../../../scripts/lib/test-output";
import { resolveBunExecutable } from "../../../scripts/lib/vitest-batches";
import {
  StandaloneKokoroService,
  speechWorkerArgs,
} from "./standalone-kokoro-service";

class Worker extends EventEmitter {
  stdin = new PassThrough();
  output = new PassThrough();
  stdio = [this.stdin, null, null, this.output];
  kill = vi.fn(() => true);
  ready() {
    this.output.emit("data", Buffer.from('{"ready":true}\n'));
  }
}
const workers: Worker[] = [];
vi.mock("node:child_process", () => ({
  spawn: () => {
    const worker = new Worker();
    workers.push(worker);
    return worker;
  },
}));

describe("standalone Kokoro cold initialization", () => {
  let service: StandaloneKokoroService;
  beforeEach(() => {
    vi.useFakeTimers();
    workers.length = 0;
    service = new StandaloneKokoroService();
  });
  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it("keeps a slow cold worker alive and shares its honest readiness", async () => {
    const first = service.initialize();
    const second = service.initialize();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(workers).toHaveLength(1);
    expect(workers[0].kill).not.toHaveBeenCalled();
    expect(service.initialized).toBe(false);
    workers[0].ready();
    await Promise.all([first, second]);
    expect(service.initialized).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(workers[0].kill).not.toHaveBeenCalled();
  });

  it("keeps a stalled boot cancellable by its owner and permits an explicit fresh attempt", async () => {
    const boot = service.initialize();
    const rejected = expect(boot).rejects.toThrow("Speech worker stopped");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(workers[0].kill).not.toHaveBeenCalled();
    service.stop();
    await rejected;
    expect(service.initialized).toBe(false);
    expect(workers[0].kill).toHaveBeenCalledWith("SIGKILL");
    const retry = service.initialize();
    workers[0].ready();
    expect(service.initialized).toBe(false);
    workers[1].ready();
    await retry;
    expect(service.initialized).toBe(true);
  });

  it("cancels shared startup immediately without waiting for the deadline", async () => {
    const boot = service.initialize();
    const rejectedBoot = expect(boot).rejects.toThrow("Speech worker stopped");
    const controller = new AbortController();
    const speech = service.synthesize(
      "00000000-0000-4000-8000-000000000001",
      "Reviewed text",
      controller.signal,
    );
    const rejectedSpeech = expect(speech).rejects.toThrow(
      "Speech worker stopped",
    );
    controller.abort();
    await Promise.all([rejectedBoot, rejectedSpeech]);
    expect(workers).toHaveLength(1);
    expect(workers[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(service.initialized).toBe(false);
    expect(service.busy).toBe(false);
  });

  it("contains pipe failure during slow startup without waiting for timeout", async () => {
    const boot = service.initialize();
    const rejected = expect(boot).rejects.toThrow("Speech worker stopped");
    await vi.advanceTimersByTimeAsync(20_000);
    workers[0].stdin.emit("error", Error("EPIPE"));
    await rejected;
    expect(workers[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(service.initialized).toBe(false);
  });

  it("settles startup when its protocol pipe closes without a worker exit", async () => {
    const boot = service.initialize();
    const rejected = expect(boot).rejects.toThrow("Speech worker stopped");
    workers[0].output.emit("end");
    await rejected;
    expect(service.initialized).toBe(false);
    expect(workers[0].kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not accept readiness after a malformed packet in the same chunk", async () => {
    const boot = service.initialize();
    const rejected = expect(boot).rejects.toThrow("Speech worker stopped");
    workers[0].output.emit("data", Buffer.from('invalid\n{"ready":true}\n'));
    await rejected;
    expect(service.initialized).toBe(false);
  });
});

describe("standalone Kokoro worker command", () => {
  it("passes the source condition only to a source worker", () => {
    expect(speechWorkerArgs("/repo/plugins/x/src/host-tts-worker.ts")).toEqual([
      "--no-install",
      "--conditions=eliza-source",
      "/repo/plugins/x/src/host-tts-worker.ts",
    ]);
    // A packaged build ships only the bundled worker; it resolves its
    // dependencies from their built files.
    expect(
      speechWorkerArgs("/app/node_modules/x/dist/host-tts-worker.js"),
    ).toEqual(["--no-install", "/app/node_modules/x/dist/host-tts-worker.js"]);
  });
});
/** Controlled subprocess/HTTP proof; native speech qualification is separate. */
const { spawn: spawnProcess } =
  await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
const protocolWorker = `
import { writeSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.env.LANG;
if (mode === 'pipe-end') createWriteStream('', {fd:3}).end();
else if (mode === 'malformed') writeSync(3, 'invalid\\n{"ready":true}\\n');
else if (mode === 'slow') {
 await new Promise(resolve => setTimeout(resolve, 61000));
 writeSync(3, '{"ready":true}\\n');
 for await (const line of createInterface({input:process.stdin})) {
  const {id, text} = JSON.parse(line);
  if (text !== 'Complete reviewed speech') throw Error('Speech source changed');
  const audio = Buffer.alloc(52);
  audio.write('RIFF'); audio.writeUInt32LE(44, 4); audio.write('WAVE', 8);
  audio.write('fmt ', 12); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(8, 40);
  audio.set([1,2,3,4,5,6,7,8], 44);
  writeSync(3, JSON.stringify({id, audio:audio.toString('base64')})+'\\n');
 }
}
setInterval(() => {}, 1000);
`;

const harness = `
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { StandaloneKokoroService } from './service.ts';
const mode = process.argv[2];
process.env.LANG = mode;
const service = new StandaloneKokoroService();
let child;
process.once('SIGTERM', async () => {
 const owned = service.child;
 const closed = owned ? once(owned, 'close') : Promise.resolve();
 service.stop();
 await closed;
 process.exit(1);
});
try {
 if (mode === 'cancel-http') {
  let admitted;
  const admission = new Promise(resolve => admitted = resolve);
  let settled;
  const outcome = new Promise(resolve => settled = resolve);
  const server = http.createServer((request, response) => {
   request.resume();
   const controller = new AbortController();
   request.once('aborted', () => controller.abort());
   response.once('close', () => controller.abort());
   const synthesis = service.synthesize('00000000-0000-4000-8000-000000000001', 'Complete reviewed speech', controller.signal);
   child = service.child;
   admitted({closed:once(child, 'close')});
   synthesis.then(() => settled(false), error => settled(error.message === 'Speech worker stopped'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = http.request({host:'127.0.0.1', port:server.address().port, method:'POST'});
  request.on('error', () => {});
  request.end('{}');
  const {closed} = await admission;
  request.destroy();
  assert.equal(await outcome, true);
  await closed;
  await new Promise(resolve => server.close(resolve));
 } else {
  const start = Date.now();
  const boot = service.initialize();
  child = service.child;
  const closed = once(child, 'close');
  if (mode === 'slow') {
   const shared = service.initialize();
   assert.equal(service.child, child);
   await Promise.all([boot, shared]);
   assert.ok(Date.now()-start >= 61000);
   assert.equal(service.initialized, true);
   const audio = await service.synthesize('00000000-0000-4000-8000-000000000001', 'Complete reviewed speech', new AbortController().signal);
   assert.equal(audio.length, 52);
   assert.deepEqual([...audio.subarray(44)], [1,2,3,4,5,6,7,8]);
   service.stop();
  } else await assert.rejects(boot, {message:'Speech worker stopped'});
  await closed;
 }
 assert.equal(service.initialized, false);
 assert.equal(service.busy, false);
 assert.equal(child.signalCode, 'SIGKILL');
 console.log(JSON.stringify({mode, passed:true, childClosed:true}));
} finally { service.stop(); }
`;

for (const mode of ["slow", "pipe-end", "malformed", "cancel-http"]) {
  test(`controlled worker process: ${mode}`, async () => {
    const output = testOutputPath("standalone-kokoro-lifecycle", "fixtures");
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(path.join(output, "worker-"));
    try {
      const provider = path.join(
        root,
        "node_modules/@elizaos/plugin-local-inference",
      );
      await mkdir(provider, { recursive: true });
      await writeFile(
        path.join(provider, "package.json"),
        JSON.stringify({
          type: "module",
          exports: { "./host-tts-worker": "./worker.mjs" },
        }),
      );
      await writeFile(path.join(provider, "worker.mjs"), protocolWorker);
      await writeFile(path.join(root, "harness.mjs"), harness);
      await writeFile(
        path.join(root, "service.ts"),
        await readFile(
          fileURLToPath(
            new URL("./standalone-kokoro-service.ts", import.meta.url),
          ),
        ),
      );
      const bun = resolveBunExecutable();
      if (!bun)
        throw Error("Bun is required for the real worker lifecycle test");
      const child = spawnProcess(
        bun,
        ["--no-install", path.join(root, "harness.mjs"), mode],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes.toString();
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes.toString();
      });
      const result = await new Promise<number | null>((resolve, reject) => {
        onTestFinished(async () => {
          child.kill("SIGTERM");
          await new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) done();
            else child.once("close", () => done());
          });
          await rm(root, { recursive: true, force: true });
        });
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(result, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        mode,
        passed: true,
        childClosed: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
