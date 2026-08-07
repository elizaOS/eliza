/**
 * Exercises the production Capacitor desired-state reconciler against a
 * multi-surface native transport with lost acknowledgements and renderer races.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CapacitorNativeSurfaceShell,
  type ElizaSurfaceManagerPlugin,
  type ElizaSurfaceManagerState,
  type NativeSurfaceOwnerIdentity,
} from "./capacitor-native-surface-shell";
import type {
  NativeSurfaceCreateRequest,
  SurfaceBounds,
  SurfaceOcclusionRect,
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

const IDENTITY_A: NativeSurfaceOwnerIdentity = {
  owner: "browser",
  session: "realm-a",
};
const IDENTITY_B: NativeSurfaceOwnerIdentity = {
  owner: "browser",
  session: "realm-b",
};
const CREATE_A: NativeSurfaceCreateRequest = {
  id: "browser-tab:a",
  url: "https://a.example",
  policy: { process: "isolated", storage: "isolated" },
};
const CREATE_B: NativeSurfaceCreateRequest = {
  ...CREATE_A,
  id: "browser-tab:b",
  url: "https://b.example",
};
const REOPENED_A: NativeSurfaceCreateRequest = {
  ...CREATE_A,
  url: "https://reopened.example",
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
      topRight: 0,
      bottomRight: 12,
      bottomLeft: 0,
    },
  },
};
const HOLES: readonly SurfaceOcclusionRect[] = [
  { x: 12, y: 580, width: 344, height: 48, cornerRadius: 24 },
];
const ABSENT_STATE: ElizaSurfaceManagerState = {
  exists: false,
  foregrounded: false,
  currentUrl: null,
  process: null,
  storage: null,
  owner: null,
  session: null,
};

type NativeOperation =
  | "reconcile"
  | "create"
  | "bounds"
  | "occlusions"
  | "navigate"
  | "reload"
  | "present"
  | "destroy"
  | "state"
  | "list";

interface NativeSurfaceRecord extends ElizaSurfaceManagerState {
  readonly id: string;
}

class StatefulNativeManager implements ElizaSurfaceManagerPlugin {
  [key: string]: unknown;
  readonly events: string[] = [];
  readonly bounds: SurfaceBounds[] = [];
  readonly occlusions: Array<readonly SurfaceOcclusionRect[]> = [];
  readonly surfaces = new Map<string, NativeSurfaceRecord>();
  private readonly failures = new Map<NativeOperation, number>();
  private readonly appliedFailures = new Map<NativeOperation, number>();
  private readonly gates = new Map<NativeOperation, Array<Deferred<void>>>();

  rejectNext(operation: NativeOperation, count = 1): void {
    this.failures.set(operation, (this.failures.get(operation) ?? 0) + count);
  }

  applyThenRejectNext(operation: NativeOperation, count = 1): void {
    this.appliedFailures.set(
      operation,
      (this.appliedFailures.get(operation) ?? 0) + count,
    );
  }

  deferNext(operation: NativeOperation): Deferred<void> {
    const gate = deferred<void>();
    const gates = this.gates.get(operation) ?? [];
    gates.push(gate);
    this.gates.set(operation, gates);
    return gate;
  }

  seed(
    identity: NativeSurfaceOwnerIdentity,
    req: NativeSurfaceCreateRequest,
  ): void {
    this.surfaces.set(req.id, {
      id: req.id,
      exists: true,
      foregrounded: false,
      currentUrl: req.url ?? null,
      process: req.policy.process,
      storage: req.policy.storage,
      owner: identity.owner,
      session: identity.session,
    });
  }

  createSurface(options: {
    owner: string;
    session: string;
    id: string;
    url?: string;
    process: "isolated" | "shared";
    storage: "isolated" | "shared";
  }): Promise<void> {
    return this.execute("create", `create:${options.id}`, () => {
      const existing = this.surfaces.get(options.id);
      if (existing) {
        if (
          existing.owner !== options.owner ||
          existing.session !== options.session ||
          existing.process !== options.process ||
          existing.storage !== options.storage
        ) {
          throw new Error("stale same-id native surface");
        }
        if (options.url) existing.currentUrl = options.url;
        return;
      }
      this.surfaces.set(options.id, {
        id: options.id,
        exists: true,
        foregrounded: false,
        currentUrl: options.url ?? null,
        process: options.process,
        storage: options.storage,
        owner: options.owner,
        session: options.session,
      });
    });
  }

  setBounds(
    options: {
      owner: string;
      session: string;
      id: string;
    } & SurfaceBounds,
  ): Promise<void> {
    return this.execute("bounds", `bounds:${options.id}`, () => {
      this.requireOwned(options);
      this.bounds.push(options);
    });
  }

  setOcclusionRects(options: {
    owner: string;
    session: string;
    id: string;
    rects: readonly SurfaceOcclusionRect[];
  }): Promise<void> {
    return this.execute("occlusions", `occlusions:${options.id}`, () => {
      this.requireOwned(options);
      this.occlusions.push(options.rects);
    });
  }

  navigate(options: {
    owner: string;
    session: string;
    id: string;
    url: string;
  }): Promise<void> {
    return this.execute("navigate", `navigate:${options.id}`, () => {
      this.requireOwned(options).currentUrl = options.url;
    });
  }

  reloadSurface(options: {
    owner: string;
    session: string;
    id: string;
  }): Promise<void> {
    return this.execute("reload", `reload:${options.id}`, () => {
      this.requireOwned(options);
    });
  }

  presentSurface(options: {
    owner: string;
    session: string;
    id: string | null;
  }): Promise<void> {
    return this.execute("present", `present:${options.id ?? "host"}`, () => {
      if (options.id) this.requireOwned({ ...options, id: options.id });
      for (const surface of this.surfaces.values()) {
        if (
          surface.owner === options.owner &&
          surface.session === options.session
        ) {
          surface.foregrounded = surface.id === options.id;
        }
      }
    });
  }

  destroySurface(options: {
    owner: string;
    session: string;
    id: string;
  }): Promise<void> {
    return this.execute("destroy", `destroy:${options.id}`, () => {
      const surface = this.surfaces.get(options.id);
      if (!surface) return;
      this.requireOwned(options);
      this.surfaces.delete(options.id);
    });
  }

  getSurfaceState(options: {
    owner: string;
    session: string;
    id: string;
  }): Promise<ElizaSurfaceManagerState> {
    return this.execute("state", `state:${options.id}`, () => undefined).then(
      () => {
        const surface = this.surfaces.get(options.id);
        return surface?.owner === options.owner &&
          surface.session === options.session
          ? { ...surface }
          : { ...ABSENT_STATE };
      },
    );
  }

  listSurfaceStates(options: {
    owner: string;
    session: string;
  }): Promise<unknown> {
    return this.execute("list", "list", () => undefined).then(() => ({
      surfaces: [...this.surfaces.values()]
        .filter(
          (surface) =>
            surface.owner === options.owner &&
            surface.session === options.session,
        )
        .map((surface) => ({ ...surface })),
    }));
  }

  reconcileOwner(options: {
    owner: string;
    session: string;
    desiredIds: readonly string[];
  }): Promise<void> {
    return this.execute("reconcile", "reconcile", () => {
      const desired = new Set(options.desiredIds);
      for (const [id, surface] of this.surfaces) {
        if (
          surface.owner === options.owner &&
          (surface.session !== options.session || !desired.has(id))
        ) {
          this.surfaces.delete(id);
        }
      }
    });
  }

  private execute(
    operation: NativeOperation,
    event: string,
    apply: () => void,
  ): Promise<void> {
    this.events.push(event);
    const gate = this.gates.get(operation)?.shift();
    if (gate) return gate.promise.then(apply);
    const failures = this.failures.get(operation) ?? 0;
    if (failures > 0) {
      this.failures.set(operation, failures - 1);
      return Promise.reject(new Error(`${operation} transport rejected`));
    }
    const appliedFailures = this.appliedFailures.get(operation) ?? 0;
    if (appliedFailures > 0) {
      this.appliedFailures.set(operation, appliedFailures - 1);
      apply();
      return Promise.reject(new Error(`${operation} acknowledgement lost`));
    }
    try {
      apply();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private requireOwned(options: {
    owner: string;
    session: string;
    id: string;
  }): NativeSurfaceRecord {
    const surface = this.surfaces.get(options.id);
    if (
      !surface ||
      surface.owner !== options.owner ||
      surface.session !== options.session
    ) {
      throw new Error(`no owned surface ${options.id}`);
    }
    return surface;
  }
}

describe("CapacitorNativeSurfaceShell", () => {
  it("holds initial geometry, holes, and presentation behind acknowledged create", async () => {
    const manager = new StatefulNativeManager();
    const gate = manager.deferNext("create");
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    const requests = [
      shell.createSurface(CREATE_A),
      shell.setBounds(CREATE_A.id, BOUNDS),
      shell.setOcclusionRects(CREATE_A.id, HOLES),
      shell.presentSurface(CREATE_A.id),
    ];

    await drainPromises();
    expect(manager.events).toEqual([
      "reconcile",
      `state:${CREATE_A.id}`,
      `create:${CREATE_A.id}`,
    ]);
    expect(shell.hasSurface(CREATE_A.id)).toBe(false);

    gate.resolve();
    await Promise.all(requests);
    expect(manager.events).toContain(`bounds:${CREATE_A.id}`);
    expect(manager.events).toContain(`occlusions:${CREATE_A.id}`);
    expect(manager.events.at(-1)).toBe(`present:${CREATE_A.id}`);
    expect(shell.hasSurface(CREATE_A.id)).toBe(true);
  });

  it("accepts a create whose mutation succeeded before its acknowledgement was lost", async () => {
    const manager = new StatefulNativeManager();
    manager.applyThenRejectNext("create");
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);

    await Promise.all([
      shell.createSurface(CREATE_A),
      shell.setBounds(CREATE_A.id, BOUNDS),
      shell.presentSurface(CREATE_A.id),
    ]);

    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      currentUrl: CREATE_A.url,
      foregrounded: true,
    });
    expect(
      manager.events.filter((event) => event.startsWith("create:")),
    ).toHaveLength(1);
  });

  it("enters a typed terminal failure after bounded attempts and converges on explicit retry", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const manager = new StatefulNativeManager();
    manager.rejectNext("create", 3);
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);

    await expect(shell.createSurface(CREATE_A)).rejects.toMatchObject({
      operation: `createSurface(${CREATE_A.id})`,
    });
    expect(shell.hasSurface(CREATE_A.id)).toBe(false);
    await shell.createSurface(CREATE_A);
    expect(shell.hasSurface(CREATE_A.id)).toBe(true);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("reconciles navigation, geometry, reload, and global visibility on a motionless page", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    manager.rejectNext("bounds", 2);
    await shell.setBounds(CREATE_A.id, BOUNDS);
    manager.rejectNext("navigate", 2);
    await shell.navigate(CREATE_A.id, "https://next.example");
    manager.rejectNext("reload", 2);
    await shell.reload(CREATE_A.id);
    manager.rejectNext("present", 2);
    await shell.presentSurface(CREATE_A.id);
    manager.rejectNext("present", 2);
    await shell.presentSurface(null);

    expect(manager.bounds).toHaveLength(1);
    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      currentUrl: "https://next.example",
      foregrounded: false,
    });
    expect(
      manager.events.filter((event) => event.startsWith("reload:")),
    ).toHaveLength(3);
  });

  it("destroys a stale generation before reopening the same id", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    manager.rejectNext("destroy", 3);
    await expect(shell.destroySurface(CREATE_A.id)).rejects.toThrow(
      /destroySurface/,
    );

    await shell.createSurface(REOPENED_A);
    expect(manager.surfaces.get(CREATE_A.id)?.currentUrl).toBe(REOPENED_A.url);
    expect(
      manager.events.filter((event) => event.startsWith("destroy:")),
    ).toHaveLength(4);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("hands an in-flight close to a newer same-id generation without adopting it", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await shell.createSurface(CREATE_A);
    const gate = manager.deferNext("destroy");
    const closing = shell.destroySurface(CREATE_A.id);
    await drainPromises();
    const reopening = shell.createSurface(REOPENED_A);
    const bounds = shell.setBounds(CREATE_A.id, BOUNDS);
    const present = shell.presentSurface(CREATE_A.id);
    gate.resolve();
    await Promise.all([closing, reopening, bounds, present]);

    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      currentUrl: REOPENED_A.url,
      foregrounded: true,
    });
  });

  it("atomically presents exactly one of two surfaces and host supersedes pending selection", async () => {
    const manager = new StatefulNativeManager();
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await Promise.all([
      shell.createSurface(CREATE_A),
      shell.createSurface(CREATE_B),
    ]);
    await shell.presentSurface(CREATE_A.id);
    expect(
      [...manager.surfaces.values()]
        .filter((state) => state.foregrounded)
        .map((state) => state.id),
    ).toEqual([CREATE_A.id]);

    const gate = manager.deferNext("present");
    const staleSelection = shell.presentSurface(CREATE_B.id);
    await drainPromises();
    const host = shell.presentSurface(null);
    gate.resolve();
    await Promise.all([staleSelection, host]);
    expect(
      [...manager.surfaces.values()].some((state) => state.foregrounded),
    ).toBe(false);
    expect(manager.events.at(-1)).toBe("present:host");
  });

  it("reconciles startup orphans and fences an already-owned older renderer realm", async () => {
    const manager = new StatefulNativeManager();
    const older = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await older.createSurface(CREATE_A);
    const newer = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_B);
    await newer.createSurface(REOPENED_A);
    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      owner: IDENTITY_B.owner,
      session: IDENTITY_B.session,
      currentUrl: REOPENED_A.url,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    await expect(
      older.navigate(CREATE_A.id, "https://stale-realm.example"),
    ).rejects.toMatchObject({ surfaceId: CREATE_A.id });
    expect(manager.surfaces.get(CREATE_A.id)).toMatchObject({
      session: IDENTITY_B.session,
      currentUrl: REOPENED_A.url,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("removes a native orphan left by a renderer that no longer exists", async () => {
    const manager = new StatefulNativeManager();
    manager.seed(IDENTITY_A, CREATE_A);
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_B);
    await shell.createSurface(CREATE_B);
    expect(manager.surfaces.has(CREATE_A.id)).toBe(false);
    expect(manager.surfaces.get(CREATE_B.id)?.session).toBe(IDENTITY_B.session);
  });

  it("rejects malformed native state instead of adopting it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();
    const manager = new StatefulNativeManager();
    (
      manager as unknown as {
        getSurfaceState(): Promise<unknown>;
      }
    ).getSurfaceState = () => Promise.resolve({ exists: true });
    const shell = new CapacitorNativeSurfaceShell(() => manager, IDENTITY_A);
    await expect(shell.createSurface(CREATE_A)).rejects.toMatchObject({
      operation: `getSurfaceState(${CREATE_A.id})`,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
