/**
 * Verifies that the server-only process adapter owns signals and exit codes
 * while the runtime host remains a reusable, idempotently closeable component.
 */
import { describe, expect, it, vi } from "vitest";
import {
  installServerOnlyProcessOwner,
  type ServerOnlyHost,
} from "./server-only-process";

function createControl() {
  const listeners = new Map<NodeJS.Signals, () => void>();
  const exits: number[] = [];
  return {
    listeners,
    exits,
    once(signal: NodeJS.Signals, listener: () => void) {
      listeners.set(signal, listener);
    },
    off(signal: NodeJS.Signals, listener: () => void) {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
    exit(code: number) {
      exits.push(code);
    },
  };
}

describe("installServerOnlyProcessOwner", () => {
  it("registers removable signal handlers and closes once", async () => {
    const close = vi.fn(async () => {});
    const host: ServerOnlyHost = { port: 2138, getRuntime: () => null, close };
    const control = createControl();
    const owner = installServerOnlyProcessOwner(host, control, 100);

    expect([...control.listeners.keys()]).toEqual(["SIGINT", "SIGTERM"]);
    await owner.shutdown("SIGTERM");
    await owner.shutdown("SIGINT");

    expect(close).toHaveBeenCalledTimes(1);
    expect(control.exits).toEqual([0]);
    owner.dispose();
    expect(control.listeners.size).toBe(0);
  });

  it("translates close failures to a non-zero exit", async () => {
    const failure = new Error("close failed");
    const host: ServerOnlyHost = {
      port: 2138,
      getRuntime: () => null,
      close: async () => {
        throw failure;
      },
    };
    const control = createControl();
    const owner = installServerOnlyProcessOwner(host, control, 100);

    await owner.shutdown();

    expect(control.exits).toEqual([1]);
  });

  it("forces one failure exit when graceful shutdown times out", async () => {
    vi.useFakeTimers();
    let finishClose: (() => void) | undefined;
    const host: ServerOnlyHost = {
      port: 2138,
      getRuntime: () => null,
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    };
    const control = createControl();
    const owner = installServerOnlyProcessOwner(host, control, 100);

    const shutdown = owner.shutdown("SIGTERM");
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(control.exits).toEqual([1]);

    finishClose?.();
    await shutdown;
    expect(control.exits).toEqual([1]);
    vi.useRealTimers();
  });
});
