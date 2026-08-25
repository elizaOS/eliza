/**
 * Pins trace singleton composition through real typed dynamic-view collaborators.
 * The deterministic harness forbids native-window calls because this boundary only registers a view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicViewRegistry } from "../dynamic-views/registry";
import { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { getTraceService, resetTraceStateForTests } from "./index.js";
import { createTraceDynamicViewManifest } from "./trace-dynamic-view";

class NoWindowCanvas {
  async createWindow(): Promise<never> {
    throw new Error("trace index harness must not create a native window");
  }

  async destroyWindow(): Promise<never> {
    throw new Error("trace index harness must not destroy a native window");
  }

  async a2uiPush(): Promise<never> {
    throw new Error("trace index harness must not push to a native window");
  }
}

function createHarness() {
  const registry = new DynamicViewRegistry();
  const register = vi.spyOn(registry, "register");
  const sessions = new DynamicViewSessionManager({
    registry,
    canvas: new NoWindowCanvas(),
  });
  return { registry, register, sessions };
}

beforeEach(() => {
  resetTraceStateForTests();
});

afterEach(() => {
  resetTraceStateForTests();
  vi.restoreAllMocks();
});

describe("trace index", () => {
  it("returns the singleton and registers the exact trace manifest", () => {
    const { registry, register, sessions } = createHarness();
    const svc1 = getTraceService({
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
    });
    const svc2 = getTraceService({
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
    });

    expect(svc1).toBe(svc2);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenNthCalledWith(
      1,
      createTraceDynamicViewManifest(),
      { update: true },
    );
    expect(register).toHaveBeenNthCalledWith(
      2,
      createTraceDynamicViewManifest(),
      { update: true },
    );
  });

  it("creates a new singleton after an isolated reset", () => {
    const { registry, register, sessions } = createHarness();
    const svc1 = getTraceService({
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
    });
    resetTraceStateForTests();
    const svc2 = getTraceService({
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
    });

    expect(svc1).not.toBe(svc2);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenNthCalledWith(
      1,
      createTraceDynamicViewManifest(),
      { update: true },
    );
    expect(register).toHaveBeenNthCalledWith(
      2,
      createTraceDynamicViewManifest(),
      { update: true },
    );
  });
});
