/** Verifies deterministic app-scoped state, stale-index rejection, fallback order, and action receipts. */

import { describe, expect, it, vi } from "vitest";
import { AppControlCoordinator, type AppControlError } from "./coordinator.js";
import type {
  AppActionRequest,
  AppControlAdapter,
  AppControlGrounder,
  AppExactWindowPointerDispatcher,
  AppPointerObserver,
  ExperimentalExactWindowAuthorizer,
  NativeAppSnapshot,
  PhysicalFallbackAuthorizer,
  PhysicalPointerDriver,
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
    focusedWindowId: 701,
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
    pointer?: PhysicalPointerDriver & AppPointerObserver;
    authorizePhysicalFallback?: PhysicalFallbackAuthorizer;
    exactWindowPointer?: AppExactWindowPointerDispatcher;
    authorizeExperimentalExactWindow?: ExperimentalExactWindowAuthorizer;
    nativeExecutionMode?: "semantic_ax" | "process_pid_keyboard_cgevent";
  } = {},
) {
  const snapshots = options.snapshots ?? [nativeSnapshot(), nativeSnapshot()];
  let snapshotIndex = 0;
  const adapter: AppControlAdapter = {
    name: "fixture-ax",
    available: () => true,
    listApps: vi.fn(async () => [app]),
    snapshot: vi.fn(async () => {
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
      targetPid: 42,
      targetWindowId: 701,
      ...(options.performSuccess === false
        ? { error: "semantic action unavailable" }
        : {}),
      ...(options.clipboardRestored !== undefined
        ? { clipboardRestored: options.clipboardRestored }
        : {}),
      ...(options.nativeExecutionMode
        ? { executionMode: options.nativeExecutionMode }
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
    pointerObserver: options.pointer,
    exactWindowPointer: options.exactWindowPointer,
    authorizeExperimentalExactWindow: options.authorizeExperimentalExactWindow,
    authorizePhysicalFallback: options.authorizePhysicalFallback,
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
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 12, y: 34 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const { adapter, coordinator } = fixture({ pointer });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(action(before.stateId));
    expect(adapter.perform).toHaveBeenCalledOnce();
    expect(outcome.receipt).toMatchObject({
      beforeStateId: before.stateId,
      executionMode: "semantic_ax",
      targetPid: 42,
      targetWindowId: 701,
      physicalPointerInput: false,
      physicalPointerMoved: false,
      pointerObservation: "unchanged",
      pointerBefore: { x: 12, y: 34 },
      pointerAfter: { x: 12, y: 34 },
      targetBounds: { x: 140, y: 240, width: 80, height: 40 },
    });
    expect(outcome.state?.stateId).not.toBe(before.stateId);
    expect(outcome.receipt?.afterStateId).toBe(outcome.state?.stateId);
  });

  it("keeps hover planning in the agent overlay without invoking AX or the pointer", async () => {
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 12, y: 34 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const { adapter, coordinator } = fixture({ pointer });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { kind: "hover_target" }),
    );
    expect(adapter.perform).not.toHaveBeenCalled();
    expect(pointer.click).not.toHaveBeenCalled();
    expect(outcome.receipt).toMatchObject({
      executionMode: "agent_overlay",
      physicalPointerInput: false,
      physicalPointerMoved: false,
      pointerObservation: "unchanged",
    });
  });

  it("classifies process-scoped keyboard input separately from physical fallback", async () => {
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 12, y: 34 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const { coordinator } = fixture({
      pointer,
      nativeExecutionMode: "process_pid_keyboard_cgevent",
      snapshots: [nativeSnapshot("Save"), nativeSnapshot("Saved")],
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { kind: "press_key", key: "return" }),
    );
    expect(pointer.click).not.toHaveBeenCalled();
    expect(outcome.receipt).toMatchObject({
      executionMode: "process_pid_keyboard_cgevent",
      physicalPointerInput: false,
      physicalPointerMoved: false,
      pointerObservation: "unchanged",
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
    let pointerPosition = { x: 12, y: 34 };
    const pointer = {
      getPosition: vi.fn(async () => ({ ...pointerPosition })),
      click: vi.fn(async (x: number, y: number) => {
        order.push("click");
        pointerPosition = { x, y };
      }),
      scroll: vi.fn(),
    };
    const authorizePhysicalFallback = vi.fn(async () => ({
      approvalId: "approval-1",
      requestedAt: "2026-08-23T00:00:00.500Z",
      approvedAt: "2026-08-23T00:00:00.750Z",
      mode: "smart_approve",
    }));
    const { adapter, coordinator } = fixture({
      performSuccess: false,
      grounder,
      pointer,
      authorizePhysicalFallback,
    });
    const perform = adapter.perform as ReturnType<typeof vi.fn>;
    perform.mockImplementation(async () => {
      order.push("ax");
      return {
        success: false,
        error: "no AXPress",
        targetPid: 42,
        targetWindowId: 701,
      };
    });
    const before = await coordinator.getAppState(app.id);
    await expect(coordinator.act(action(before.stateId))).rejects.toMatchObject(
      {
        code: "PHYSICAL_FALLBACK_DENIED",
      },
    );
    expect(pointer.click).not.toHaveBeenCalled();
    expect(authorizePhysicalFallback).not.toHaveBeenCalled();

    const fresh = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(fresh.stateId, { allowPhysicalFallback: true }),
    );
    expect(order.slice(-3)).toEqual(["ax", "ground", "click"]);
    expect(outcome.receipt).toMatchObject({
      executionMode: "guarded_physical",
      groundingMode: "set_of_marks",
      physicalPointerInput: true,
      physicalPointerMoved: true,
      pointerObservation: "changed",
      pointerBefore: { x: 12, y: 34 },
      pointerAfter: { x: 180, y: 260 },
      physicalFallbackApproval: { approvalId: "approval-1" },
    });
  });

  it("pauses after grounding and before any physical input until separately approved", async () => {
    let releaseApproval: (() => void) | undefined;
    let markApprovalStarted: (() => void) | undefined;
    const approvalStarted = new Promise<void>((resolve) => {
      markApprovalStarted = resolve;
    });
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const authorizePhysicalFallback = vi.fn(async () => {
      markApprovalStarted?.();
      await approval;
      return {
        approvalId: "approval-paused",
        requestedAt: "2026-08-23T00:00:00.500Z",
        approvedAt: "2026-08-23T00:00:00.750Z",
        mode: "smart_approve",
      };
    });
    let pointerPosition = { x: 20, y: 30 };
    const pointer = {
      getPosition: vi.fn(async () => ({ ...pointerPosition })),
      click: vi.fn(async (x: number, y: number) => {
        pointerPosition = { x, y };
      }),
      scroll: vi.fn(),
    };
    const { coordinator } = fixture({
      performSuccess: false,
      grounder: {
        ground: vi.fn(async () => ({
          mode: "ocr" as const,
          displayId: 7,
          x: 200,
          y: 300,
        })),
      },
      pointer,
      authorizePhysicalFallback,
    });
    const before = await coordinator.getAppState(app.id);
    const pending = coordinator.act(
      action(before.stateId, { allowPhysicalFallback: true }),
    );
    await approvalStarted;
    expect(authorizePhysicalFallback).toHaveBeenCalled();
    expect(pointer.click).not.toHaveBeenCalled();
    releaseApproval?.();
    const outcome = await pending;
    expect(pointer.click).toHaveBeenCalledWith(200, 300);
    expect(outcome.receipt?.physicalFallbackApproval?.approvalId).toBe(
      "approval-paused",
    );
  });

  it("cancels a pending physical approval without injecting input", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const authorizePhysicalFallback: PhysicalFallbackAuthorizer = vi.fn(
      async (_request, signal) => {
        markStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("approval cancelled")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 20, y: 30 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const { coordinator } = fixture({
      performSuccess: false,
      pointer,
      authorizePhysicalFallback,
    });
    const before = await coordinator.getAppState(app.id);
    const controller = new AbortController();
    const pending = coordinator.act(
      action(before.stateId, { allowPhysicalFallback: true }),
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow("approval cancelled");
    expect(pointer.click).not.toHaveBeenCalled();
  });

  it("does not call observed pointer movement virtual when no pointer input ran", async () => {
    const positions = [
      { x: 692, y: 765 },
      { x: 497, y: 704 },
    ];
    const pointer = {
      getPosition: vi.fn(async () => positions.shift() ?? { x: 497, y: 704 }),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const { coordinator } = fixture({ pointer });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(action(before.stateId));
    expect(outcome.receipt).toMatchObject({
      executionMode: "semantic_ax",
      physicalPointerInput: false,
      physicalPointerMoved: true,
      pointerObservation: "changed",
      pointerBefore: { x: 692, y: 765 },
      pointerAfter: { x: 497, y: 704 },
    });
  });

  it("refuses click when semantic AX is absent and no approved physical route exists", async () => {
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 692, y: 765 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const { adapter, coordinator } = fixture({ pointer });
    const perform = adapter.perform as ReturnType<typeof vi.fn>;
    perform.mockResolvedValue({
      success: false,
      error:
        "The element exposed no semantic action; exact window-local pointer dispatch is unavailable",
      targetPid: 42,
      targetWindowId: 701,
    });
    const before = await coordinator.getAppState(app.id);
    await expect(coordinator.act(action(before.stateId))).resolves.toEqual({
      success: false,
      error:
        "The element exposed no semantic action; exact window-local pointer dispatch is unavailable",
    });
    expect(pointer.click).not.toHaveBeenCalled();
    expect(pointer.getPosition).toHaveBeenCalledOnce();
  });

  it("uses the explicit experimental route only after AX refusal and exact receipt validation", async () => {
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 692, y: 765 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async ({ state }) => ({
        success: true,
        route: "experimental_direct_exact_window" as const,
        observationId: state.stateId,
        targetPid: 42,
        targetWindowId: 701,
        targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        pointerBefore: { x: 692, y: 765 },
        pointerAfter: { x: 692, y: 765 },
      })),
    };
    const authorizeExperimentalExactWindow = vi.fn(async () => ({
      approvalId: "approval-exact-1",
      requestedAt: "2026-08-23T00:00:00.500Z",
      approvedAt: "2026-08-23T00:00:00.750Z",
      mode: "smart_approve",
    }));
    const { coordinator } = fixture({
      pointer,
      exactWindowPointer,
      authorizeExperimentalExactWindow,
      performSuccess: false,
      snapshots: [nativeSnapshot("Save"), nativeSnapshot("Saved")],
    });
    const before = await coordinator.getAppState(app.id);
    const outcome = await coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    expect(exactWindowPointer.dispatch).toHaveBeenCalledOnce();
    expect(authorizeExperimentalExactWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        observationId: before.stateId,
        targetPid: 42,
        targetWindowId: 701,
        windowBounds: { x: 100, y: 200, width: 800, height: 600 },
        targetBounds: { x: 140, y: 240, width: 80, height: 40 },
      }),
      undefined,
    );
    expect(pointer.click).not.toHaveBeenCalled();
    expect(outcome.receipt).toMatchObject({
      executionMode: "experimental_direct_exact_window",
      targetPid: 42,
      targetWindowId: 701,
      targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
      physicalPointerInput: false,
      pointerObservation: "unchanged",
      experimentalExactWindowApproval: {
        approvalId: "approval-exact-1",
      },
    });
  });

  it("pauses before experimental helper dispatch until the separate approval resolves", async () => {
    let releaseApproval: (() => void) | undefined;
    let markApprovalStarted: (() => void) | undefined;
    const approvalStarted = new Promise<void>((resolve) => {
      markApprovalStarted = resolve;
    });
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 100, y: 200 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async ({ state }) => ({
        success: true,
        route: "experimental_direct_exact_window" as const,
        observationId: state.stateId,
        targetPid: 42,
        targetWindowId: 701,
        targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
        pointerBefore: { x: 100, y: 200 },
        pointerAfter: { x: 100, y: 200 },
      })),
    };
    const authorizeExperimentalExactWindow = vi.fn(async () => {
      markApprovalStarted?.();
      await approval;
      return {
        approvalId: "approval-exact-paused",
        requestedAt: "2026-08-23T00:00:00.500Z",
        approvedAt: "2026-08-23T00:00:00.750Z",
        mode: "smart_approve",
      };
    });
    const { coordinator } = fixture({
      pointer,
      exactWindowPointer,
      authorizeExperimentalExactWindow,
      performSuccess: false,
      snapshots: [nativeSnapshot("Save"), nativeSnapshot("Saved")],
    });
    const before = await coordinator.getAppState(app.id);
    const pending = coordinator.act(
      action(before.stateId, { allowExperimentalExactWindow: true }),
    );
    await approvalStarted;
    expect(exactWindowPointer.dispatch).not.toHaveBeenCalled();
    expect(pointer.click).not.toHaveBeenCalled();
    releaseApproval?.();
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(exactWindowPointer.dispatch).toHaveBeenCalledOnce();
  });

  it("refuses an experimental receipt for a different window geometry", async () => {
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 100, y: 200 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const { coordinator } = fixture({
      pointer,
      performSuccess: false,
      exactWindowPointer: {
        available: () => true,
        dispatch: vi.fn(async ({ state }) => ({
          success: true,
          route: "experimental_direct_exact_window" as const,
          observationId: state.stateId,
          targetPid: 42,
          targetWindowId: 701,
          targetWindowBounds: { x: 101, y: 200, width: 800, height: 600 },
          pointerBefore: { x: 100, y: 200 },
          pointerAfter: { x: 100, y: 200 },
        })),
      },
      authorizeExperimentalExactWindow: vi.fn(async () => ({
        approvalId: "approval-exact-bounds",
        requestedAt: "2026-08-23T00:00:00.500Z",
        approvedAt: "2026-08-23T00:00:00.750Z",
        mode: "smart_approve",
      })),
    });
    const before = await coordinator.getAppState(app.id);
    await expect(
      coordinator.act(
        action(before.stateId, { allowExperimentalExactWindow: true }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("target or pointer validation"),
    });
    expect(pointer.click).not.toHaveBeenCalled();
  });

  it("recaptures after approval and refuses a stale exact-window binding", async () => {
    const moved = {
      ...nativeSnapshot("Save"),
      focusedWindowBounds: { x: 101, y: 200, width: 800, height: 600 },
    };
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(),
    };
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 100, y: 200 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const { coordinator } = fixture({
      pointer,
      performSuccess: false,
      exactWindowPointer,
      snapshots: [nativeSnapshot("Save"), moved],
      authorizeExperimentalExactWindow: vi.fn(async () => ({
        approvalId: "approval-exact-stale",
        requestedAt: "2026-08-23T00:00:00.500Z",
        approvedAt: "2026-08-23T00:00:00.750Z",
        mode: "smart_approve",
      })),
    });
    const before = await coordinator.getAppState(app.id);
    await expect(
      coordinator.act(
        action(before.stateId, { allowExperimentalExactWindow: true }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("changed after approval"),
    });
    expect(exactWindowPointer.dispatch).not.toHaveBeenCalled();
    expect(pointer.click).not.toHaveBeenCalled();
  });

  it.each(["changed", "unavailable"] as const)(
    "refuses experimental success when the coordinator post-observation is %s",
    async (postObservation) => {
      let pointerReads = 0;
      const pointer = {
        getPosition: vi.fn(async () => {
          pointerReads += 1;
          if (pointerReads === 1) return { x: 100, y: 200 };
          if (postObservation === "changed") return { x: 101, y: 200 };
          throw new Error("fixture pointer observer unavailable");
        }),
        click: vi.fn(),
        scroll: vi.fn(),
      };
      const exactWindowPointer: AppExactWindowPointerDispatcher = {
        available: () => true,
        dispatch: vi.fn(async ({ state }) => ({
          success: true,
          route: "experimental_direct_exact_window" as const,
          observationId: state.stateId,
          targetPid: 42,
          targetWindowId: 701,
          targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
          pointerBefore: { x: 100, y: 200 },
          pointerAfter: { x: 100, y: 200 },
        })),
      };
      const { coordinator } = fixture({
        pointer,
        exactWindowPointer,
        performSuccess: false,
        snapshots: [nativeSnapshot("Save"), nativeSnapshot("Saved")],
        authorizeExperimentalExactWindow: vi.fn(async () => ({
          approvalId: `approval-exact-${postObservation}`,
          requestedAt: "2026-08-23T00:00:00.500Z",
          approvedAt: "2026-08-23T00:00:00.750Z",
          mode: "smart_approve",
        })),
      });
      const before = await coordinator.getAppState(app.id);
      await expect(
        coordinator.act(
          action(before.stateId, { allowExperimentalExactWindow: true }),
        ),
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining(
          `coordinator pointer observation was ${postObservation}`,
        ),
      });
      expect(exactWindowPointer.dispatch).toHaveBeenCalledOnce();
      expect(pointer.click).not.toHaveBeenCalled();
    },
  );

  it("does not let an experimental event received by sibling B verify target A", async () => {
    let siblingValue = "before";
    const pointer = {
      getPosition: vi.fn(async () => ({ x: 100, y: 200 })),
      click: vi.fn(),
      scroll: vi.fn(),
    };
    const exactWindowPointer: AppExactWindowPointerDispatcher = {
      available: () => true,
      dispatch: vi.fn(async ({ state }) => {
        siblingValue = "after";
        return {
          success: true,
          route: "experimental_direct_exact_window" as const,
          observationId: state.stateId,
          targetPid: 42,
          targetWindowId: 701,
          targetWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
          pointerBefore: { x: 100, y: 200 },
          pointerAfter: { x: 100, y: 200 },
        };
      }),
    };
    const authorizeExperimentalExactWindow = vi.fn(async () => ({
      approvalId: "approval-exact-sibling",
      requestedAt: "2026-08-23T00:00:00.500Z",
      approvedAt: "2026-08-23T00:00:00.750Z",
      mode: "smart_approve",
    }));
    const { coordinator } = fixture({
      pointer,
      exactWindowPointer,
      authorizeExperimentalExactWindow,
      performSuccess: false,
    });
    const before = await coordinator.getAppState(app.id);
    await expect(
      coordinator.act(
        action(before.stateId, { allowExperimentalExactWindow: true }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("action-specific target-element readback"),
    });
    expect(siblingValue).toBe("after");
    expect(pointer.click).not.toHaveBeenCalled();
  });

  it("refuses when a process-scoped key mutates sibling B but target A readback is unchanged", async () => {
    let siblingValue = "before";
    const { coordinator } = fixture({
      nativeExecutionMode: "process_pid_keyboard_cgevent",
    });
    const before = await coordinator.getAppState(app.id);
    siblingValue = "after";
    await expect(
      coordinator.act(
        action(before.stateId, { kind: "press_key", key: "tab" }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("target-element readback"),
    });
    expect(siblingValue).toBe("after");
  });

  it("does not accept a sibling window as fresh verification", async () => {
    const sibling = { ...nativeSnapshot("Saved"), focusedWindowId: 702 };
    const { coordinator } = fixture({
      snapshots: [nativeSnapshot("Save"), sibling],
    });
    const before = await coordinator.getAppState(app.id);
    await expect(
      coordinator.act(action(before.stateId)),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("sibling-window state"),
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
