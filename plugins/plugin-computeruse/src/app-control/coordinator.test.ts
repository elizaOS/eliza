/** Verifies deterministic app-scoped state, stale-index rejection, fallback order, and action receipts. */

import { describe, expect, it, vi } from "vitest";
import { AppControlCoordinator, type AppControlError } from "./coordinator.js";
import type {
  AppActionRequest,
  AppControlAdapter,
  AppControlGrounder,
  NativeAppSnapshot,
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
