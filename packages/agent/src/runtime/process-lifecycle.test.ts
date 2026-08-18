/** Verifies idempotent reverse teardown and detachable process signal ownership. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentProcessLifecycle,
  installParentProcessExitHandler,
  installProcessSignalHandlers,
} from "./process-lifecycle.ts";

describe("agent process lifecycle", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
  });

  it("disposes host resources in reverse order exactly once", async () => {
    const events: string[] = [];
    const lifecycle = createAgentProcessLifecycle({
      disposeRuntime: async (reason) => {
        events.push(`runtime:${reason}`);
      },
      disposeSandbox: async () => {
        events.push("sandbox");
      },
    });
    lifecycle.addTeardown(() => {
      events.push("first");
    });
    lifecycle.addTeardown(() => {
      events.push("second");
    });

    await Promise.all([
      lifecycle.dispose("test"),
      lifecycle.dispose("ignored"),
    ]);
    expect(events).toEqual(["second", "first", "sandbox", "runtime:test"]);
  });

  it("keeps signal installation at the process boundary", async () => {
    const dispose = vi.fn(async () => undefined);
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const exit = vi.fn(() => {
      resolveExit?.();
    }) as unknown as (code: number) => never;
    const detach = installProcessSignalHandlers({
      lifecycle: { addTeardown: vi.fn(), dispose },
      onError: vi.fn(),
      exit,
    });
    cleanup.push(detach);

    process.emit("SIGTERM", "SIGTERM");
    await exited;
    expect(dispose).toHaveBeenCalledWith("signal shutdown");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("disposes an embedded runtime when its desktop parent disappears", async () => {
    vi.useFakeTimers();
    let observedParentPid = 42;
    const dispose = vi.fn(async () => undefined);
    const exit = vi.fn() as unknown as (code: number) => never;
    const detach = installParentProcessExitHandler({
      lifecycle: { addTeardown: vi.fn(), dispose },
      parentPid: 42,
      readParentPid: () => observedParentPid,
      onError: vi.fn(),
      exit,
      pollIntervalMs: 10,
    });
    cleanup.push(() => {
      detach();
      vi.useRealTimers();
    });

    vi.advanceTimersByTime(10);
    expect(dispose).not.toHaveBeenCalled();

    observedParentPid = 1;
    vi.advanceTimersByTime(10);
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledWith("desktop parent exited");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
