/**
 * Exercises the real Capacitor surface command sequencer against an in-memory
 * transport. Deferred and rejected creates prove that initial native geometry
 * cannot race ahead of surface acceptance or become permanently poisoned.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CapacitorNativeSurfaceShell,
  type ElizaSurfaceManagerPlugin,
} from "./capacitor-native-surface-shell";
import type {
  NativeSurfaceCreateRequest,
  SurfaceBounds,
} from "./native-surface-shell";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function drainPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const CREATE_REQUEST: NativeSurfaceCreateRequest = {
  id: "browser-tab:a",
  url: "https://example.com",
  policy: { process: "isolated", storage: "isolated" },
};

const BOUNDS: SurfaceBounds = {
  x: 8,
  y: 72,
  width: 368,
  height: 640,
  outerClip: {
    x: 8,
    y: 72,
    width: 368,
    height: 640,
    cornerRadii: {
      topLeft: 24,
      topRight: 24,
      bottomRight: 24,
      bottomLeft: 24,
    },
  },
};

class RecordingNativeManager implements ElizaSurfaceManagerPlugin {
  [key: string]: unknown;
  readonly events: string[] = [];
  readonly createResults: Array<() => Promise<void>> = [];
  readonly boundsResults: Array<() => Promise<void>> = [];

  createSurface(): Promise<void> {
    this.events.push("create");
    return this.createResults.shift()?.() ?? Promise.resolve();
  }

  setBounds(): Promise<void> {
    this.events.push("bounds");
    return this.boundsResults.shift()?.() ?? Promise.resolve();
  }

  setOcclusionRects(): Promise<void> {
    this.events.push("occlusions");
    return Promise.resolve();
  }

  navigate(): Promise<void> {
    this.events.push("navigate");
    return Promise.resolve();
  }

  foregroundSurface(): Promise<void> {
    this.events.push("foreground");
    return Promise.resolve();
  }

  backgroundSurface(): Promise<void> {
    this.events.push("background");
    return Promise.resolve();
  }

  destroySurface(): Promise<void> {
    this.events.push("destroy");
    return Promise.resolve();
  }

  foregroundHost(): Promise<void> {
    this.events.push("host");
    return Promise.resolve();
  }
}

describe("CapacitorNativeSurfaceShell", () => {
  it("holds initial geometry, holes, and foreground until native create accepts", async () => {
    const createGate = deferred<void>();
    const manager = new RecordingNativeManager();
    manager.createResults.push(() => createGate.promise);
    const shell = new CapacitorNativeSurfaceShell(() => manager);

    shell.createSurface(CREATE_REQUEST);
    shell.setBounds(CREATE_REQUEST.id, BOUNDS);
    shell.setBounds(CREATE_REQUEST.id, BOUNDS);
    shell.setOcclusionRects(CREATE_REQUEST.id, []);
    shell.setOcclusionRects(CREATE_REQUEST.id, []);
    shell.foregroundSurface(CREATE_REQUEST.id);

    expect(manager.events).toEqual([]);
    expect(shell.hasSurface(CREATE_REQUEST.id)).toBe(false);
    await Promise.resolve();
    expect(manager.events).toEqual(["create"]);

    createGate.resolve();
    await drainPromises();

    expect(manager.events).toEqual([
      "create",
      "bounds",
      "occlusions",
      "foreground",
    ]);
    expect(shell.hasSurface(CREATE_REQUEST.id)).toBe(true);
  });

  it("recovers one rejected create before releasing queued initial commands", async () => {
    const manager = new RecordingNativeManager();
    manager.createResults.push(
      () => Promise.reject(new Error("bridge not ready")),
      () => Promise.resolve(),
    );
    const shell = new CapacitorNativeSurfaceShell(() => manager);

    shell.createSurface(CREATE_REQUEST);
    shell.setBounds(CREATE_REQUEST.id, BOUNDS);
    shell.foregroundSurface(CREATE_REQUEST.id);
    await drainPromises();

    expect(manager.events).toEqual([
      "create",
      "create",
      "bounds",
      "foreground",
    ]);
    expect(shell.hasSurface(CREATE_REQUEST.id)).toBe(true);
  });

  it("retries identical geometry after rejection and caches only native success", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new RecordingNativeManager();
    manager.boundsResults.push(
      () => Promise.reject(new Error("bounds transport rejection")),
      () => Promise.resolve(),
    );
    const shell = new CapacitorNativeSurfaceShell(() => manager);

    shell.createSurface(CREATE_REQUEST);
    shell.setBounds(CREATE_REQUEST.id, BOUNDS);
    shell.setBounds(CREATE_REQUEST.id, BOUNDS);
    await drainPromises();

    expect(manager.events).toEqual(["create", "bounds", "bounds"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    shell.setBounds(CREATE_REQUEST.id, BOUNDS);
    await drainPromises();
    expect(manager.events).toEqual(["create", "bounds", "bounds"]);
  });

  it("clears an exhausted create so a later explicit create can recover", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new RecordingNativeManager();
    manager.createResults.push(
      () => Promise.reject(new Error("first rejection")),
      () => Promise.reject(new Error("second rejection")),
    );
    const shell = new CapacitorNativeSurfaceShell(() => manager);

    shell.createSurface(CREATE_REQUEST);
    shell.setBounds(CREATE_REQUEST.id, BOUNDS);
    await drainPromises();
    expect(shell.hasSurface(CREATE_REQUEST.id)).toBe(false);
    expect(manager.events).toEqual(["create", "create"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    shell.createSurface(CREATE_REQUEST);
    shell.setBounds(CREATE_REQUEST.id, BOUNDS);
    await drainPromises();

    expect(manager.events).toEqual(["create", "create", "create", "bounds"]);
    expect(shell.hasSurface(CREATE_REQUEST.id)).toBe(true);
  });
});
