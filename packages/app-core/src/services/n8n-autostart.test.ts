/**
 * Unit tests for n8n-autostart.ts — boot-time sidecar spawn.
 *
 * Covers:
 * - auto-starts when desktop + localEnabled + unauth
 * - skips when mobile
 * - skips when localEnabled=false
 * - skips when cloud-authed
 * - skips when sidecar already exists (hot-reload case)
 * - poke() re-evaluates
 * - stop() is idempotent and cancels the pending first tick
 * - boot-start failure is caught and does not throw
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startN8nAutoStart } from "./n8n-autostart";
import {
  disposeN8nSidecar,
  type N8nSidecar,
  type N8nSidecarConfig,
  type N8nSidecarStatus,
} from "./n8n-sidecar";

interface FakeAuth {
  isAuthenticated: () => boolean;
}

function makeRuntime(auth: FakeAuth | null): AgentRuntime {
  return {
    getService: (name: string) =>
      name === "CLOUD_AUTH" ? (auth as unknown as object) : null,
  } as unknown as AgentRuntime;
}

interface SidecarStubHandle {
  sidecar: { start: ReturnType<typeof vi.fn> };
  getSidecar: (
    config: N8nSidecarConfig,
  ) => Promise<{ start: () => Promise<void> }>;
}

function makeSidecarStub(start?: () => Promise<void>): SidecarStubHandle {
  const sidecar = {
    start: vi.fn(async () => {
      if (start) await start();
    }),
  };
  const getSidecar = vi.fn(async () => sidecar);
  return { sidecar, getSidecar };
}

function makeExistingSidecar(status: N8nSidecarStatus): N8nSidecar {
  return {
    getState: () => ({
      status,
      host: null,
      port: null,
      errorMessage: null,
      pid: null,
      retries: 0,
    }),
  } as unknown as N8nSidecar;
}

describe("n8n-autostart", () => {
  beforeEach(async () => {
    await disposeN8nSidecar();
  });

  afterEach(async () => {
    await disposeN8nSidecar();
  });

  it("auto-starts when desktop + localEnabled + unauth", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        initialDelayMs: 0,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    // Poke forces immediate evaluation (cancels the pending first tick).
    await handle.poke();

    expect(getSidecar).toHaveBeenCalledTimes(1);
    expect(sidecar.start).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("skips when mobile", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        initialDelayMs: 0,
        isMobile: () => true,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    await handle.poke();

    expect(getSidecar).not.toHaveBeenCalled();
    expect(sidecar.start).not.toHaveBeenCalled();

    await handle.stop();
  });

  it("skips when localEnabled=false", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: false } },
      {
        initialDelayMs: 0,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    await handle.poke();

    expect(getSidecar).not.toHaveBeenCalled();
    expect(sidecar.start).not.toHaveBeenCalled();

    await handle.stop();
  });

  it("skips when cloud-authed", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => true });
    const { sidecar, getSidecar } = makeSidecarStub();

    const handle = startN8nAutoStart(
      runtime,
      {
        cloud: { enabled: true },
        n8n: { localEnabled: true },
      },
      {
        initialDelayMs: 0,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    await handle.poke();

    expect(getSidecar).not.toHaveBeenCalled();
    expect(sidecar.start).not.toHaveBeenCalled();

    await handle.stop();
  });

  it("skips when sidecar already exists (hot-reload case)", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();
    const existing = makeExistingSidecar("ready");

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        initialDelayMs: 0,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => existing,
      },
    );

    await handle.poke();

    expect(getSidecar).not.toHaveBeenCalled();
    expect(sidecar.start).not.toHaveBeenCalled();

    await handle.stop();
  });

  it("skips when sidecar is already starting (hot-reload case)", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();
    const existing = makeExistingSidecar("starting");

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        initialDelayMs: 0,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => existing,
      },
    );

    await handle.poke();

    expect(getSidecar).not.toHaveBeenCalled();
    expect(sidecar.start).not.toHaveBeenCalled();

    await handle.stop();
  });

  it("re-spawns when existing sidecar is stopped (peek returns stopped)", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();
    const existing = makeExistingSidecar("stopped");

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        initialDelayMs: 0,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => existing,
      },
    );

    await handle.poke();

    // A "stopped" peek is not considered live, so autostart proceeds.
    expect(getSidecar).toHaveBeenCalledTimes(1);
    expect(sidecar.start).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("poke() re-evaluates after config hot-reload flips localEnabled on", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();
    let cfg = { n8n: { localEnabled: false } as { localEnabled: boolean } };

    const handle = startN8nAutoStart(runtime, cfg, {
      initialDelayMs: 0,
      isMobile: () => false,
      getSidecar,
      peekSidecar: () => null,
      getConfig: () => cfg,
    });

    // First poke: localEnabled=false, should skip.
    await handle.poke();
    expect(sidecar.start).not.toHaveBeenCalled();

    // Flip the config and poke again.
    cfg = { n8n: { localEnabled: true } };
    await handle.poke();
    expect(sidecar.start).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("stop() is idempotent", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { getSidecar } = makeSidecarStub();

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        // Large delay so the first tick never fires before stop().
        initialDelayMs: 10_000,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    await handle.stop();
    // Second stop is a no-op.
    await handle.stop();

    // The pending first tick should have been cancelled, so the sidecar
    // getter must never have been invoked.
    expect(getSidecar).not.toHaveBeenCalled();
  });

  it("stop() prevents a later poke() from evaluating", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        initialDelayMs: 10_000,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    await handle.stop();
    await handle.poke();

    expect(getSidecar).not.toHaveBeenCalled();
    expect(sidecar.start).not.toHaveBeenCalled();
  });

  it("boot-start failure at getSidecar() is caught and does not throw", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const getSidecar = vi.fn(async () => {
      throw new Error("spawn boom");
    });

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        initialDelayMs: 0,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    // poke() must resolve cleanly even though getSidecar rejected.
    await expect(handle.poke()).resolves.toBeUndefined();

    expect(getSidecar).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("boot-start failure at sidecar.start() is caught and does not throw", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const sidecar = {
      start: vi.fn(async () => {
        throw new Error("start boom");
      }),
    };
    const getSidecar = vi.fn(async () => sidecar);

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        initialDelayMs: 0,
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    // poke() awaits the outer getSidecar() but the start() is fire-and-
    // forget — either way, no error should propagate to the caller.
    await expect(handle.poke()).resolves.toBeUndefined();

    // Flush pending microtasks so the rejected start() promise has a
    // chance to hit the inner .catch handler.
    await Promise.resolve();
    await Promise.resolve();

    expect(sidecar.start).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("default initialDelayMs (50ms) fires the first tick automatically", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const { sidecar, getSidecar } = makeSidecarStub();

    const handle = startN8nAutoStart(
      runtime,
      { n8n: { localEnabled: true } },
      {
        isMobile: () => false,
        getSidecar,
        peekSidecar: () => null,
      },
    );

    await vi.waitFor(() => {
      expect(sidecar.start).toHaveBeenCalledTimes(1);
    });

    await handle.stop();
  });
});
