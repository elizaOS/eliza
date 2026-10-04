import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StandaloneKokoroService } from "./standalone-kokoro-service";

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

  it("bounds a stalled boot and permits an explicit fresh attempt", async () => {
    const boot = service.initialize();
    const rejected = expect(boot).rejects.toThrow("Speech worker stopped");
    await vi.advanceTimersByTimeAsync(60_001);
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
});
