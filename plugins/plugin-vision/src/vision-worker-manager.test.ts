/**
 * Lifecycle tests for VisionWorkerManager.
 *
 * A crashed worker schedules its restart one second later. That timer must not
 * survive `stop()`: a restart that runs after shutdown creates a fresh worker
 * thread with no owner, so screen capture and OCR keep running.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeWorker {
    static created: FakeWorker[] = [];

    private listeners = new Map<string, Listener[]>();
    readonly posted: unknown[] = [];

    constructor(
      readonly filename: string,
      readonly options: unknown,
    ) {
      FakeWorker.created.push(this);
    }

    on(event: string, listener: Listener): this {
      const current = this.listeners.get(event) ?? [];
      current.push(listener);
      this.listeners.set(event, current);
      return this;
    }

    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: Listener): this {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        current.filter((candidate) => candidate !== listener),
      );
      return this;
    }

    postMessage(message: unknown): void {
      this.posted.push(message);
      if ((message as { type?: string } | undefined)?.type === "stop") {
        queueMicrotask(() => this.emit("exit", 0));
      }
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    static reset(): void {
      FakeWorker.created = [];
    }
  }

  return { FakeWorker };
});

vi.mock("node:worker_threads", () => ({ Worker: harness.FakeWorker }));

import { VisionWorkerManager } from "./vision-worker-manager";

const CONFIG = {
  targetScreenFPS: 30,
  ocrEnabled: true,
  displayIndex: 0,
};

async function waitForRestartWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_200));
}

describe("VisionWorkerManager restart lifecycle", () => {
  beforeEach(() => {
    harness.FakeWorker.reset();
  });

  it("restarts a crashed worker while the manager is running", async () => {
    const manager = new VisionWorkerManager(CONFIG);
    await manager.initialize();
    expect(harness.FakeWorker.created).toHaveLength(2);

    harness.FakeWorker.created[1]?.emit("exit", 1);
    await waitForRestartWindow();

    expect(harness.FakeWorker.created).toHaveLength(3);
    await manager.stop();
  });

  it("does not start a worker after stop()", async () => {
    const manager = new VisionWorkerManager(CONFIG);
    await manager.initialize();

    const [, ocrWorker] = harness.FakeWorker.created;
    ocrWorker?.emit("exit", 1);
    await manager.stop();
    expect(harness.FakeWorker.created).toHaveLength(2);

    // The stale worker can still report an error after shutdown.
    ocrWorker?.emit("error", new Error("late worker error"));
    await waitForRestartWindow();

    expect(harness.FakeWorker.created).toHaveLength(2);
  });
});
