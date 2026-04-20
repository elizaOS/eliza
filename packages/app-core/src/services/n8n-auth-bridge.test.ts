/**
 * Unit tests for n8n-auth-bridge.ts — auth-state → sidecar lifecycle.
 *
 * Covers:
 * - unauth → auth releases the local sidecar (when status is starting/ready)
 * - auth → unauth spins up local sidecar (when localEnabled, not mobile)
 * - auth → unauth does nothing when localEnabled=false
 * - auth → unauth does nothing on mobile
 * - debounce window suppresses flaps within 2 s
 * - unauth → auth with no sidecar is a no-op
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startN8nAuthBridge } from "./n8n-auth-bridge";
import {
  disposeN8nSidecar,
  getN8nSidecar,
  type N8nSidecar,
  type N8nSidecarState,
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

function makeSidecarStub(status: N8nSidecarStatus): N8nSidecar {
  const state: N8nSidecarState = {
    status,
    host: null,
    port: null,
    errorMessage: null,
    pid: null,
    retries: 0,
  };
  return {
    getState: () => state,
    getApiKey: () => null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as N8nSidecar;
}

describe("n8n-auth-bridge", () => {
  beforeEach(async () => {
    // Reset the module-level sidecar singleton between cases.
    await disposeN8nSidecar();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disposeN8nSidecar();
  });

  it("releases the sidecar on unauth → auth when status is 'ready'", async () => {
    // Seed a sidecar in ready state.
    const sidecar = makeSidecarStub("ready");
    // Prime the singleton by constructing one via getN8nSidecar and then
    // monkey-patching its state. We need peekN8nSidecar() to see a sidecar
    // with status=ready, so we replace the real one with our stub.
    const existing = getN8nSidecar({ enabled: true });
    Object.assign(existing, {
      getState: sidecar.getState,
      stop: sidecar.stop,
    });

    let isAuth = false;
    const runtime = makeRuntime({ isAuthenticated: () => isAuth });
    const stopSpy = vi.spyOn(existing, "stop");

    const handle = startN8nAuthBridge(
      runtime,
      { n8n: { localEnabled: true } },
      { pollIntervalMs: 100, debounceMs: 2_000 },
    );

    // Flip auth on, wait long enough for the debounce to not apply.
    vi.setSystemTime(new Date(10_000));
    isAuth = true;
    handle.poke();

    // disposeN8nSidecar calls existing.stop()
    await vi.waitFor(() => {
      expect(stopSpy).toHaveBeenCalled();
    });

    handle.stop();
  });

  it("starts the sidecar on auth → unauth when localEnabled and not mobile", async () => {
    let isAuth = true;
    const runtime = makeRuntime({ isAuthenticated: () => isAuth });

    const handle = startN8nAuthBridge(
      runtime,
      { n8n: { localEnabled: true } },
      { pollIntervalMs: 100, debounceMs: 2_000, isMobile: () => false },
    );

    // First poke establishes lastState=true (no transition).
    handle.poke();

    // Move past debounce window before the first transition.
    vi.setSystemTime(new Date(10_000));
    isAuth = false;

    // Spy on the lazy singleton before the transition — the bridge calls
    // getN8nSidecar(config).start(), which lazily constructs a singleton.
    handle.poke();

    // After the transition, the singleton should have been constructed and
    // start() scheduled. Verify by peeking.
    const { peekN8nSidecar } = await import("./n8n-sidecar");
    const created = peekN8nSidecar();
    expect(created).not.toBeNull();

    handle.stop();
  });

  it("does nothing on auth → unauth when localEnabled=false", async () => {
    let isAuth = true;
    const runtime = makeRuntime({ isAuthenticated: () => isAuth });

    const handle = startN8nAuthBridge(
      runtime,
      { n8n: { localEnabled: false } },
      { pollIntervalMs: 100, debounceMs: 2_000, isMobile: () => false },
    );
    handle.poke();
    vi.setSystemTime(new Date(10_000));
    isAuth = false;
    handle.poke();

    const { peekN8nSidecar } = await import("./n8n-sidecar");
    expect(peekN8nSidecar()).toBeNull();

    handle.stop();
  });

  it("does nothing on auth → unauth when mobile", async () => {
    let isAuth = true;
    const runtime = makeRuntime({ isAuthenticated: () => isAuth });

    const handle = startN8nAuthBridge(
      runtime,
      { n8n: { localEnabled: true } },
      { pollIntervalMs: 100, debounceMs: 2_000, isMobile: () => true },
    );
    handle.poke();
    vi.setSystemTime(new Date(10_000));
    isAuth = false;
    handle.poke();

    const { peekN8nSidecar } = await import("./n8n-sidecar");
    expect(peekN8nSidecar()).toBeNull();

    handle.stop();
  });

  it("suppresses flap within the 2 s debounce window", async () => {
    let isAuth = false;
    const runtime = makeRuntime({ isAuthenticated: () => isAuth });

    const handle = startN8nAuthBridge(
      runtime,
      { n8n: { localEnabled: true } },
      { pollIntervalMs: 100, debounceMs: 2_000, isMobile: () => false },
    );
    handle.poke();

    // First transition unauth → auth at t=0 is allowed (no prior transition).
    vi.setSystemTime(new Date(500));
    isAuth = true;
    handle.poke();

    // Second transition auth → unauth at t=1s should be ignored by debounce.
    vi.setSystemTime(new Date(1_000));
    isAuth = false;
    handle.poke();

    // The bridge should NOT have spawned a local sidecar on the debounced
    // flap. peekN8nSidecar stays null.
    const { peekN8nSidecar } = await import("./n8n-sidecar");
    expect(peekN8nSidecar()).toBeNull();

    handle.stop();
  });

  it("is a no-op on unauth → auth when no sidecar exists", async () => {
    let isAuth = false;
    const runtime = makeRuntime({ isAuthenticated: () => isAuth });

    const handle = startN8nAuthBridge(
      runtime,
      { n8n: { localEnabled: true } },
      { pollIntervalMs: 100, debounceMs: 0 },
    );
    handle.poke();
    vi.setSystemTime(new Date(10_000));
    isAuth = true;
    handle.poke();

    // Nothing to stop — the test passes if no exception is thrown.
    handle.stop();
  });

  it("stop() halts the poller", async () => {
    const runtime = makeRuntime({ isAuthenticated: () => false });
    const handle = startN8nAuthBridge(
      runtime,
      { n8n: { localEnabled: true } },
      { pollIntervalMs: 100, debounceMs: 0 },
    );
    handle.stop();
    // Second stop is idempotent.
    handle.stop();
  });
});
