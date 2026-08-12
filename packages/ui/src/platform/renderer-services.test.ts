/**
 * @vitest-environment jsdom
 *
 * Exercises the renderer-service lifecycle registry with real service
 * definitions and the real global store — no mocked lifecycle: registration
 * order-independence, shell-scope gating, disposer retention and invocation on
 * dispose/pagehide/host replacement/re-registration (HMR), race-safe stop
 * during a pending async start, and observable failure states.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRendererServiceStates,
  type RendererServiceCleanup,
  registerRendererService,
  resetRendererServicesForTest,
  settleRendererServices,
  startRendererServiceHost,
} from "./renderer-services";

function makeService(
  id: string,
  shells: readonly ("main" | "popout" | "detached")[] = ["main"],
) {
  const cleanup = vi.fn();
  const start = vi.fn(() => cleanup as RendererServiceCleanup);
  return { definition: { id, shells, start }, start, cleanup };
}

function stateOf(id: string) {
  return getRendererServiceStates().services.find((s) => s.id === id)?.status;
}

afterEach(() => {
  resetRendererServicesForTest();
});

describe("registration and host startup ordering", () => {
  it("starts services registered before the host arrives", async () => {
    const svc = makeService("a.before-host");
    registerRendererService(svc.definition);
    expect(svc.start).not.toHaveBeenCalled();
    expect(stateOf("a.before-host")).toBe("registered");

    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(1);
    expect(stateOf("a.before-host")).toBe("running");
  });

  it("starts services registered after the host arrives (idle-path loads)", async () => {
    startRendererServiceHost({ shell: "main" });
    const svc = makeService("a.after-host");
    registerRendererService(svc.definition);
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(1);
    expect(stateOf("a.after-host")).toBe("running");
  });

  it("passes the host shell and a live abort signal to start", async () => {
    const seen: { shell?: string; aborted?: boolean } = {};
    registerRendererService({
      id: "a.context",
      shells: ["main"],
      start: (context) => {
        seen.shell = context.shell;
        seen.aborted = context.signal.aborted;
        return () => {};
      },
    });
    const host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(seen).toEqual({ shell: "main", aborted: false });
    host.dispose();
  });

  it("rejects definitions with an empty id or no shells", () => {
    expect(() =>
      registerRendererService({
        id: "  ",
        shells: ["main"],
        start: () => () => {},
      }),
    ).toThrow(/non-empty id/);
    expect(() =>
      registerRendererService({
        id: "a.no-shells",
        shells: [],
        start: () => () => {},
      }),
    ).toThrow(/declares no shells/);
  });
});

describe("shell scoping", () => {
  it("never starts a main-scoped service in popout/detached shells", async () => {
    const svc = makeService("a.main-only", ["main"]);
    registerRendererService(svc.definition);

    const popout = startRendererServiceHost({ shell: "popout" });
    await settleRendererServices();
    expect(svc.start).not.toHaveBeenCalled();
    expect(stateOf("a.main-only")).toBe("ineligible");
    popout.dispose();

    const detached = startRendererServiceHost({ shell: "detached" });
    await settleRendererServices();
    expect(svc.start).not.toHaveBeenCalled();
    detached.dispose();
  });

  it("starts a multi-shell service in each declared shell", async () => {
    const svc = makeService("a.multi", ["main", "popout"]);
    registerRendererService(svc.definition);

    const popout = startRendererServiceHost({ shell: "popout" });
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(1);
    popout.dispose();
    expect(svc.cleanup).toHaveBeenCalledTimes(1);

    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(2);
  });
});

describe("teardown", () => {
  it("invokes every retained cleanup on host dispose", async () => {
    const a = makeService("a.one");
    const b = makeService("a.two");
    registerRendererService(a.definition);
    registerRendererService(b.definition);
    const host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    host.dispose();
    expect(a.cleanup).toHaveBeenCalledTimes(1);
    expect(b.cleanup).toHaveBeenCalledTimes(1);
    // Dispose is idempotent.
    host.dispose();
    expect(a.cleanup).toHaveBeenCalledTimes(1);
  });

  it("disposes on pagehide (page teardown)", async () => {
    const svc = makeService("a.pagehide");
    registerRendererService(svc.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    window.dispatchEvent(new Event("pagehide"));
    expect(svc.cleanup).toHaveBeenCalledTimes(1);
    expect(getRendererServiceStates().hostShell).toBeNull();
  });

  it("suspends every instance on a persisted pagehide (bfcache) and restarts them on pageshow", async () => {
    const svc = makeService("a.bfcache");
    registerRendererService(svc.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    // bfcache entry: persisted=true (iOS Safari back-nav). The page can come
    // back via pageshow, so the host itself survives, but every instance's
    // owned native resources must be suspended now — the freeze can happen
    // mid-flight, so only *initiating* teardown needs to be synchronous.
    const persisted = new Event("pagehide") as Event & { persisted: boolean };
    Object.defineProperty(persisted, "persisted", { value: true });
    window.dispatchEvent(persisted);
    expect(svc.cleanup).toHaveBeenCalledTimes(1);
    expect(stateOf("a.bfcache")).toBe("stopped");
    expect(getRendererServiceStates().hostShell).toBe("main");

    // Restore from bfcache: pageshow restarts the suspended service through
    // the same serialized queue.
    const pageshow = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(2);
    expect(stateOf("a.bfcache")).toBe("running");

    // A real teardown (persisted=false) still fully disposes the host.
    window.dispatchEvent(new Event("pagehide"));
    expect(svc.cleanup).toHaveBeenCalledTimes(2);
    expect(getRendererServiceStates().hostShell).toBeNull();
  });

  it("restarted suspended service waits for a still-pending suspension cleanup", async () => {
    let releaseCleanup: (() => void) | undefined;
    const start = vi.fn(
      () => () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    registerRendererService({
      id: "a.slow-suspend",
      shells: ["main"],
      start,
    });
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(start).toHaveBeenCalledTimes(1);

    const persisted = new Event("pagehide") as Event & { persisted: boolean };
    Object.defineProperty(persisted, "persisted", { value: true });
    window.dispatchEvent(persisted);

    const pageshow = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);

    // The restart is queued but must not run until the pending suspension
    // cleanup settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    releaseCleanup?.();
    await settleRendererServices();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("stops the previous host's instances on host replacement", async () => {
    const svc = makeService("a.replaced-host");
    registerRendererService(svc.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(svc.start).toHaveBeenCalledTimes(1);

    // A second boot (HMR of the shell, repeated test boots) replaces the host:
    // old instance stops before the new one starts.
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(svc.cleanup).toHaveBeenCalledTimes(1);
    expect(svc.start).toHaveBeenCalledTimes(2);
    expect(stateOf("a.replaced-host")).toBe("running");
  });

  it("re-registering an id stops the old instance before starting the new one (HMR)", async () => {
    const first = makeService("a.hmr");
    registerRendererService(first.definition);
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    const second = makeService("a.hmr");
    registerRendererService(second.definition);
    await settleRendererServices();

    expect(first.cleanup).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(stateOf("a.hmr")).toBe("running");
  });

  it("reports a throwing cleanup and still tears down the remaining services", async () => {
    const reportError = vi.fn();
    const bad = {
      id: "a.bad-cleanup",
      shells: ["main"] as const,
      start: () => () => {
        throw new Error("cleanup exploded");
      },
    };
    const good = makeService("a.good-cleanup");
    registerRendererService(bad);
    registerRendererService(good.definition);
    const host = startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    host.dispose();
    expect(good.cleanup).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "a.bad-cleanup",
      expect.any(Error),
      "cleanup",
    );
  });
});

describe("async cleanup serialization (#17110)", () => {
  it("awaits an async cleanup before starting the successor on re-registration", async () => {
    let releaseCleanup: (() => void) | undefined;
    const firstStart = vi.fn(
      () => () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    const secondStart = vi.fn(() => () => {});
    registerRendererService({
      id: "a.async-hmr",
      shells: ["main"],
      start: firstStart,
    });
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(firstStart).toHaveBeenCalledTimes(1);

    registerRendererService({
      id: "a.async-hmr",
      shells: ["main"],
      start: secondStart,
    });

    // The old instance's cleanup is still pending — the successor must not
    // have started yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    releaseCleanup?.();
    await settleRendererServices();
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(stateOf("a.async-hmr")).toBe("running");
  });

  it("awaits the prior host's full disposal before the replacement host's services start", async () => {
    let releaseCleanup: (() => void) | undefined;
    const start = vi.fn(
      () => () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    registerRendererService({
      id: "a.async-host-replace",
      shells: ["main"],
      start,
    });
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(start).toHaveBeenCalledTimes(1);

    // Host replacement (shell HMR, repeated test boots) while the old
    // instance's cleanup is still pending — the new host's instance must not
    // start until the old host has fully disposed.
    startRendererServiceHost({ shell: "main" });

    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    releaseCleanup?.();
    await settleRendererServices();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("reports a rejecting async cleanup and still unblocks the successor", async () => {
    const reportError = vi.fn();
    let rejectCleanup: ((error: Error) => void) | undefined;
    registerRendererService({
      id: "a.async-reject-cleanup",
      shells: ["main"],
      start: () => () =>
        new Promise<void>((_resolve, reject) => {
          rejectCleanup = reject;
        }),
    });
    startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    const second = makeService("a.async-reject-cleanup");
    registerRendererService(second.definition);
    rejectCleanup?.(new Error("cleanup rejected"));

    await settleRendererServices();
    expect(reportError).toHaveBeenCalledWith(
      "a.async-reject-cleanup",
      expect.any(Error),
      "cleanup",
    );
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(stateOf("a.async-reject-cleanup")).toBe("running");
  });

  it("a late-completing predecessor cleanup cannot stop the running successor", async () => {
    let releaseCleanup: (() => void) | undefined;
    registerRendererService({
      id: "a.late-cleanup-safety",
      shells: ["main"],
      start: () => () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    });
    startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    const successor = makeService("a.late-cleanup-safety");
    registerRendererService(successor.definition);
    await Promise.resolve();
    await Promise.resolve();
    expect(successor.start).not.toHaveBeenCalled();

    releaseCleanup?.();
    await settleRendererServices();
    expect(successor.start).toHaveBeenCalledTimes(1);
    expect(stateOf("a.late-cleanup-safety")).toBe("running");

    // The predecessor's long-settled cleanup resolving even later must not
    // retroactively stop or clean up the now-running successor.
    await Promise.resolve();
    await Promise.resolve();
    expect(successor.cleanup).not.toHaveBeenCalled();
    expect(stateOf("a.late-cleanup-safety")).toBe("running");
  });
});

describe("race-safe async start", () => {
  it("runs the late cleanup when stopped during an awaited start", async () => {
    const cleanup = vi.fn();
    let releaseStart: (() => void) | undefined;
    registerRendererService({
      id: "a.slow-start",
      shells: ["main"],
      start: async () => {
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
        return cleanup;
      },
    });
    const host = startRendererServiceHost({ shell: "main" });
    expect(stateOf("a.slow-start")).toBe("starting");

    // Stop while start is still pending — no cleanup exists yet.
    host.dispose();
    expect(cleanup).not.toHaveBeenCalled();

    // The start finishes late; its cleanup must run immediately, leaving no
    // orphaned listeners/intervals behind.
    releaseStart?.();
    await settleRendererServices();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejection from a start that was already stopped", async () => {
    const reportError = vi.fn();
    let rejectStart: ((error: Error) => void) | undefined;
    registerRendererService({
      id: "a.aborted-reject",
      shells: ["main"],
      start: async () => {
        await new Promise<never>((_, reject) => {
          rejectStart = reject;
        });
        return () => {};
      },
    });
    const host = startRendererServiceHost({ shell: "main", reportError });
    host.dispose();
    rejectStart?.(new Error("torn down mid-start"));
    await settleRendererServices();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("observable failures", () => {
  it("marks a rejecting start failed and reports it", async () => {
    const reportError = vi.fn();
    registerRendererService({
      id: "a.start-fails",
      shells: ["main"],
      start: async () => {
        throw new Error("no device");
      },
    });
    startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    expect(stateOf("a.start-fails")).toBe("failed");
    expect(reportError).toHaveBeenCalledWith(
      "a.start-fails",
      expect.any(Error),
      "start",
    );
  });

  it("treats a start that returns no cleanup as a contract violation", async () => {
    const reportError = vi.fn();
    registerRendererService({
      id: "a.no-cleanup",
      shells: ["main"],
      // Deliberately violates the contract at runtime.
      start: (() => undefined) as unknown as () => RendererServiceCleanup,
    });
    startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    expect(stateOf("a.no-cleanup")).toBe("failed");
    expect(reportError).toHaveBeenCalledWith(
      "a.no-cleanup",
      expect.objectContaining({
        message: expect.stringContaining("cleanup function"),
      }),
      "start",
    );
  });

  it("a failed service does not block other services from running", async () => {
    const reportError = vi.fn();
    registerRendererService({
      id: "a.fails",
      shells: ["main"],
      start: () => {
        throw new Error("boom");
      },
    });
    const good = makeService("a.survives");
    registerRendererService(good.definition);
    startRendererServiceHost({ shell: "main", reportError });
    await settleRendererServices();

    expect(stateOf("a.fails")).toBe("failed");
    expect(stateOf("a.survives")).toBe("running");
  });
});
