/** Verifies deterministic app-scoped state, stale-index rejection, fallback order, and action receipts. */

import { describe, expect, it, vi } from "vitest";
import { AppControlCoordinator, type AppControlError } from "./coordinator.js";
import type {
  AppActionRequest,
  AppControlAdapter,
  AppControlGrounder,
  AppExactWindowPointerDispatcher,
  NativeAppSnapshot,
  PhysicalPointerDriver,
  PhysicalPointerObserver,
} from "./types.js";

const app = {
  id: "fixture.app",
  name: "Computer Use Fixture",
  pid: 42,
  active: true,
};

function nativeSnapshot(label = "Save"): NativeAppSnapshot {
  return {
    app,
    capturedAt: "2026-08-23T00:00:00.000Z",
    permission: "ready",
    focusedWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
    axText: `[1] AXButton ${label}`,
    elements: [
      {
        locator: [0, 2],
        role: "AXButton",
        label,
        bounds: { x: 140, y: 240, width: 80, height: 40 },
        actions: ["AXPress", "AXShowMenu"],
        enabled: true,
        focused: false,
        secure: false,
      },
    ],
  };
}

function fixture(
  options: {
    snapshots?: NativeAppSnapshot[];
    performSuccess?: boolean;
    clipboardRestored?: boolean;
    permission?: NativeAppSnapshot["permission"];
    grounder?: AppControlGrounder;
    pointer?: PhysicalPointerDriver;
    pointerObserver?: PhysicalPointerObserver;
    exactWindowPointer?: AppExactWindowPointerDispatcher;
    snapshotErrorAt?: number;
  } = {},
) {
  const snapshots = options.snapshots ?? [nativeSnapshot(), nativeSnapshot()];
  let snapshotIndex = 0;
  const adapter: AppControlAdapter = {
    name: "fixture-ax",
    available: () => true,
    listApps: vi.fn(async () => [app]),
    snapshot: vi.fn(async () => {
      if (snapshotIndex === options.snapshotErrorAt) {
        snapshotIndex += 1;
        throw new Error("post-state fixture unavailable");
      }
      const source = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
      if (!source) throw new Error("fixture requires at least one snapshot");
      snapshotIndex += 1;
      return {
        ...source,
        permission: options.permission ?? source.permission,
      };
    }),
    perform: vi.fn(async () => ({
      success: options.performSuccess ?? true,
      ...(options.performSuccess === false
        ? { error: "semantic action unavailable" }
        : {}),
      ...(options.clipboardRestored !== undefined
        ? { clipboardRestored: options.clipboardRestored }
        : {}),
    })),
  };
  let id = 0;
  const coordinator = new AppControlCoordinator({
    adapter,
    capture: {
      capture: vi.fn(async (snapshot) => ({
        screenshot: Buffer.from(snapshot.axText).toString("base64"),
        displayId: 7,
        bounds: snapshot.focusedWindowBounds ?? {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      })),
    },
    grounder: options.grounder,
    pointer: options.pointer,
    pointerObserver:
      options.pointerObserver ??
      ({
        position: vi.fn(async () => ({ x: 10, y: 20 })),
      } satisfies PhysicalPointerObserver),
    exactWindowPointer: options.exactWindowPointer,
    now: () => Date.parse("2026-08-23T00:00:01.000Z"),
    idFactory: () => `id-${++id}`,
  });
  return { adapter, coordinator };
}

function action(
  stateId: string,
  overrides: Partial<AppActionRequest> = {},
): AppActionRequest {
  return {
    app: app.id,
    stateId,
    kind: "click",
    element_index: 1,
    ...overrides,
  };
}

describe("AppControlCoordinator", () => {
  it("lists apps and returns full state followed by an incremental diff", async () => {
    const { coordinator } = fixture({
      snapshots: [nativeSnapshot("Save"), nativeSnapshot("Saved")],
    });
    await expect(coordinator.listApps()).resolves.toEqual([app]);
    const first = await coordinator.getAppState(app.id);
    const second = await coordinator.getAppState(app.id);
    expect(first.elements[0]).toMatchObject({
      element_index: 1,
      role: "AXButton",
      label: "Save",
    });
    expect(first.elements[0]).not.toHaveProperty("locator");
    expect(second.diff).toEqual({
      baseStateId: first.stateId,
      added: [1],
      changed: [1],
      removed: [1],
      axTextChanged: true,
    });
    expect(second.screenshotBounds).toEqual({
      x: 100,
      y: 200,
      width: 800,
      height: 600,
    });
  });

  it("invalidates every element_index when a newer state is captured", async () => {
    const { coordinator } = fixture();
    const first = await coordinator.getAppState(app.id);
    await coordinator.getAppState(app.id);
    await expect(coordinator.act(action(first.stateId))).rejects.toMatchObject({
      code: "STALE_APP_STATE",
    });
  });

  it("uses the semantic AX action first and automatically recaptures state", async () => {
    const { adapter, coordinator } = fixture();
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(action(before.stateId));
    expect(adapter.perform).toHaveBeenCalledOnce();
    expect(outcome.receipt).toMatchObject({
      beforeStateId: before.stateId,
      executionMode: "semantic_ax",
      physicalPointerMoved: false,
      targetBounds: { x: 140, y: 240, width: 80, height: 40 },
    });
    expect(outcome.state?.stateId).not.toBe(before.stateId);
    expect(outcome.receipt?.afterStateId).toBe(outcome.state?.stateId);
  });

  it("keeps the exact-window dispatcher disabled unless explicitly opted in", async () => {
    const dispatch = vi.fn(async () => ({
      success: true,
      route: "experimental_direct_exact_window" as const,
      observationId: "unused",
      targetPid: app.pid,
      targetWindowId: 17,
      targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
      pointerBefore: { x: 10, y: 20 },
      pointerAfter: { x: 10, y: 20 },
    }));
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch,
    };
    const snapshots = [nativeSnapshot(), nativeSnapshot()];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      exactWindowPointer,
    });
    const before = await coordinator.getAppState(app.id);
    await coordinator.act(action(before.stateId));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never invokes exact-window when semantic AX succeeds, even with opt-in", async () => {
    const dispatch = vi.fn();
    const snapshots = [nativeSnapshot(), nativeSnapshot()];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      exactWindowPointer: { available: () => true, dispatch },
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.receipt?.executionMode).toBe("semantic_ax");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("selects exact-window only for a fully gated opt-in and preserves its receipt", async () => {
    const dispatch = vi.fn(async (input) => ({
      success: true,
      route: "experimental_direct_exact_window" as const,
      observationId: input.state.stateId,
      targetPid: app.pid,
      targetWindowId: 17,
      targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
      pointerBefore: { x: 10, y: 20 },
      pointerAfter: { x: 10, y: 20 },
    }));
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch,
    };
    const snapshots = [
      nativeSnapshot(),
      nativeSnapshot(),
      nativeSnapshot("Saved"),
    ];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      exactWindowPointer,
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].state.stateId).not.toBe(before.stateId);
    expect(outcome.receipt).toMatchObject({
      executionMode: "experimental_direct_exact_window",
      effectStatus: "confirmed",
      physicalPointerMoved: false,
    });
  });

  it("refuses changed targets before exact-window side effects", async () => {
    const dispatch = vi.fn();
    const replaced = nativeSnapshot("Replaced");
    const replacedElement = replaced.elements[0];
    if (!replacedElement) throw new Error("fixture target is required");
    replacedElement.bounds = {
      x: 141,
      y: 240,
      width: 80,
      height: 40,
    };
    const snapshots = [nativeSnapshot(), replaced];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      exactWindowPointer: { available: () => true, dispatch },
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("changed during pre-dispatch recapture");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("requires independent cursor provenance before exact-window dispatch", async () => {
    const dispatch = vi.fn();
    const snapshots = [nativeSnapshot(), nativeSnapshot()];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      pointerObserver: {
        position: vi.fn(async () => {
          throw new Error("cursor unavailable");
        }),
      },
      exactWindowPointer: { available: () => true, dispatch },
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("pointer provenance");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns posted-unconfirmed when independent cursor provenance changes", async () => {
    const positions = [
      { x: 10, y: 20 },
      { x: 11, y: 20 },
    ];
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async (input) => ({
        success: true,
        route: "experimental_direct_exact_window" as const,
        observationId: input.state.stateId,
        targetPid: app.pid,
        targetWindowId: 17,
        targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        pointerBefore: { x: 10, y: 20 },
        pointerAfter: { x: 10, y: 20 },
      })),
    };
    const snapshots = [nativeSnapshot(), nativeSnapshot()];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      pointerObserver: {
        position: vi.fn(async () => positions.shift() ?? { x: 11, y: 20 }),
      },
      exactWindowPointer,
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.success).toBe(true);
    expect(outcome.receipt).toMatchObject({
      effectStatus: "posted_unconfirmed",
      effectDiagnostic: { code: "POST_DISPATCH_POINTER_CHANGED" },
      changed: false,
      physicalPointerMoved: true,
    });
  });

  it("returns posted-unconfirmed when the post-dispatch pointer read throws", async () => {
    let readCount = 0;
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async (input) => ({
        success: true,
        route: "experimental_direct_exact_window" as const,
        observationId: input.state.stateId,
        targetPid: app.pid,
        targetWindowId: 17,
        targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        pointerBefore: { x: 10, y: 20 },
        pointerAfter: { x: 10, y: 20 },
      })),
    };
    const snapshots = [nativeSnapshot(), nativeSnapshot()];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      pointerObserver: {
        position: vi.fn(async () => {
          readCount += 1;
          if (readCount === 2) throw new Error("observer disconnected");
          return { x: 10, y: 20 };
        }),
      },
      exactWindowPointer,
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.success).toBe(true);
    expect(outcome.receipt).toMatchObject({
      effectStatus: "posted_unconfirmed",
      effectDiagnostic: {
        code: "POST_DISPATCH_POINTER_UNAVAILABLE",
        cause: "observer disconnected",
      },
      changed: false,
    });
  });

  it("returns posted-unconfirmed when post-state capture throws", async () => {
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async (input) => ({
        success: true,
        route: "experimental_direct_exact_window" as const,
        observationId: input.state.stateId,
        targetPid: app.pid,
        targetWindowId: 17,
        targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        pointerBefore: { x: 10, y: 20 },
        pointerAfter: { x: 10, y: 20 },
      })),
    };
    const snapshots = [nativeSnapshot(), nativeSnapshot()];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      snapshotErrorAt: 2,
      exactWindowPointer,
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.success).toBe(true);
    expect(outcome.receipt).toMatchObject({
      effectStatus: "posted_unconfirmed",
      effectDiagnostic: {
        code: "POST_DISPATCH_STATE_UNAVAILABLE",
        cause: "post-state fixture unavailable",
      },
      changed: false,
    });
  });

  it("returns posted-unconfirmed instead of a retryable failure when target readback is unchanged", async () => {
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async (input) => ({
        success: true,
        route: "experimental_direct_exact_window" as const,
        observationId: input.state.stateId,
        targetPid: app.pid,
        targetWindowId: 17,
        targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        pointerBefore: { x: 10, y: 20 },
        pointerAfter: { x: 10, y: 20 },
      })),
    };
    const unrelated = nativeSnapshot();
    unrelated.axText = `${unrelated.axText}\nUnrelated sibling changed`;
    const snapshots = [nativeSnapshot(), nativeSnapshot(), unrelated];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      exactWindowPointer,
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.receipt).toMatchObject({
      executionMode: "experimental_direct_exact_window",
      effectStatus: "posted_unconfirmed",
      changed: false,
    });
  });

  it("returns posted-unconfirmed when post-dispatch focus leaves the target window", async () => {
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async (input) => ({
        success: true,
        route: "experimental_direct_exact_window" as const,
        observationId: input.state.stateId,
        targetPid: app.pid,
        targetWindowId: 17,
        targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        pointerBefore: { x: 10, y: 20 },
        pointerAfter: { x: 10, y: 20 },
      })),
    };
    const initial = nativeSnapshot();
    initial.focusedWindowId = 17;
    const fresh = nativeSnapshot();
    fresh.focusedWindowId = 17;
    const siblingWindow = nativeSnapshot("Saved");
    siblingWindow.focusedWindowId = 18;
    const snapshots = [initial, fresh, siblingWindow];
    const { coordinator } = fixture({
      snapshots,
      exactWindowPointer,
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.success).toBe(true);
    expect(outcome.receipt).toMatchObject({
      effectStatus: "posted_unconfirmed",
      changed: false,
    });
  });

  it("returns posted-unconfirmed for mismatched post-dispatch receipt bounds", async () => {
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async (input) => ({
        success: true,
        route: "experimental_direct_exact_window" as const,
        observationId: input.state.stateId,
        targetPid: app.pid,
        targetWindowId: 17,
        targetWindowBounds: { x: 0, y: 0, width: 1, height: 1 },
        pointerBefore: { x: 10, y: 20 },
        pointerAfter: { x: 10, y: 20 },
      })),
    };
    const snapshots = [nativeSnapshot(), nativeSnapshot(), nativeSnapshot()];
    for (const snapshot of snapshots) snapshot.focusedWindowId = 17;
    const { coordinator } = fixture({
      snapshots,
      exactWindowPointer,
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(outcome.success).toBe(true);
    expect(outcome.receipt).toMatchObject({
      effectStatus: "posted_unconfirmed",
      effectDiagnostic: { code: "POST_DISPATCH_RECEIPT_UNVERIFIED" },
      changed: false,
    });
  });

  it("keeps hover planning in the agent overlay without invoking AX or the pointer", async () => {
    const pointer = { click: vi.fn(), scroll: vi.fn() };
    const { adapter, coordinator } = fixture({ pointer });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { kind: "hover_target" }),
    );
    expect(adapter.perform).not.toHaveBeenCalled();
    expect(pointer.click).not.toHaveBeenCalled();
    expect(outcome.receipt).toMatchObject({
      executionMode: "agent_overlay",
      physicalPointerMoved: false,
    });
  });

  it("uses Set-of-Marks only after AX fails and only with physical approval", async () => {
    const order: string[] = [];
    const grounder: AppControlGrounder = {
      ground: vi.fn(async () => {
        order.push("ground");
        return { mode: "set_of_marks", displayId: 7, x: 180, y: 260 };
      }),
    };
    const pointer = {
      click: vi.fn(async () => order.push("click")),
      scroll: vi.fn(),
    };
    const { adapter, coordinator } = fixture({
      performSuccess: false,
      grounder,
      pointer,
    });
    vi.mocked(adapter.perform).mockImplementation(async () => {
      order.push("ax");
      return { success: false, error: "no AXPress" };
    });
    const before = await coordinator.getAppState(app.id);
    await expect(coordinator.act(action(before.stateId))).rejects.toMatchObject(
      {
        code: "PHYSICAL_FALLBACK_DENIED",
      },
    );
    expect(pointer.click).not.toHaveBeenCalled();

    const fresh = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(fresh.stateId, { allowPhysicalFallback: true }),
    );
    expect(order.slice(-3)).toEqual(["ax", "ground", "click"]);
    expect(outcome.receipt).toMatchObject({
      executionMode: "set_of_marks",
      physicalPointerMoved: true,
    });
  });

  it("records clipboard restoration and rejects unexposed secondary actions", async () => {
    const { coordinator } = fixture({ clipboardRestored: true });
    const before = await coordinator.getAppState(app.id);
    const pasted = await coordinator.act(
      action(before.stateId, { kind: "paste", text: "safe fixture" }),
    );
    expect(pasted.receipt?.clipboardRestored).toBe(true);

    const latest = pasted.state;
    if (!latest) throw new Error("successful paste must return a fresh state");
    await expect(
      coordinator.act(
        action(latest.stateId, {
          kind: "secondary_action",
          secondaryAction: "AXDelete",
        }),
      ),
    ).rejects.toMatchObject({ code: "ACTION_NOT_EXPOSED" });
  });

  it("fails closed when accessibility permission is unavailable", async () => {
    const { coordinator } = fixture({ permission: "accessibility_denied" });
    await expect(coordinator.getAppState(app.id)).rejects.toEqual(
      expect.objectContaining<AppControlError>({
        code: "APP_PERMISSION_DENIED",
      }),
    );
  });
});
