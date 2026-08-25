/**
 * Covers the legacy computer-use session compat adapter: snapshot-to-canonical
 * session mapping per target kind, legacy-command-to-canonical-kind mapping
 * observed at the real core authorization seam, parameter coercion at the
 * compat boundary, and the sandbox/remote opaque-request lane. The core
 * dispatch authority is spy-wrapped but always delegated to the real
 * implementation, so every observed mapping must ALSO authorize; no platform
 * drivers, no network, no mocks of the module under test.
 */

import { INTERACTION_CONTRACT_VERSION } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeCompatibilitySessionAction,
  toCanonicalInteractionSession,
} from "./canonical-compat.js";
import type {
  ComputerUseSessionAction,
  ComputerUseSessionSnapshot,
} from "./types.js";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    authorizeInteractionDispatch: vi.fn(actual.authorizeInteractionDispatch),
  };
});

const T0 = "2026-08-25T00:00:00.000Z";
const NOW = Date.parse(T0) + 60_000;

function snapshot(
  overrides: Partial<ComputerUseSessionSnapshot> = {},
): ComputerUseSessionSnapshot {
  return {
    contractVersion: INTERACTION_CONTRACT_VERSION,
    id: "sess-1",
    ownerId: "owner-1",
    adapterId: "adapter-1",
    canonicalState: "running",
    isolationMode: "shared_desktop",
    generation: 3,
    label: "test session",
    target: { kind: "host" },
    status: "running",
    sequence: 7,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function action(
  overrides: Partial<ComputerUseSessionAction> = {},
): ComputerUseSessionAction {
  return {
    actionId: "act-1",
    expectedSequence: 8,
    command: "click",
    parameters: { coordinate: [10, 20] },
    ...overrides,
  };
}

interface DispatchCall {
  kind: string;
  payload: Record<string, unknown>;
}

/** Run one compat authorization and return the mapped kind+payload the core authority received. */
async function mappedDispatch(
  session: ComputerUseSessionSnapshot,
  act: ComputerUseSessionAction,
): Promise<DispatchCall> {
  const { authorizeInteractionDispatch } = await import("@elizaos/core");
  const spy = vi.mocked(authorizeInteractionDispatch);
  spy.mockClear();
  await authorizeCompatibilitySessionAction(session, act, NOW);
  expect(spy).toHaveBeenCalledTimes(1);
  const dispatched = spy.mock.calls[0]?.[0] as {
    kind: string;
    payload: Record<string, unknown>;
  };
  expect(dispatched).toBeDefined();
  return { kind: dispatched.kind, payload: dispatched.payload };
}

describe("toCanonicalInteractionSession", () => {
  it("normalizes a host session onto the display surface", () => {
    const session = toCanonicalInteractionSession(snapshot());
    expect(session.sessionId).toBe("sess-1");
    expect(session.ownerId).toBe("owner-1");
    expect(session.adapterId).toBe("adapter-1");
    expect(session.contractVersion).toBe(INTERACTION_CONTRACT_VERSION);
    expect(session.state).toBe("running");
    expect(session.generation).toBe(3);
    expect(session.isolationMode).toBe("shared_desktop");
    expect(session.surfaces).toHaveLength(1);
    const surface = session.surfaces[0];
    expect(surface?.kind).toBe("display");
    expect(surface?.surfaceId).toBe("host-display");
    expect(surface?.parentSurfaceId).toBeNull();
    expect(surface?.generation).toBe(3);
    expect(session.profileGrant).toBeNull();
    expect(session.expiresAt).toBeNull();
  });

  it("prefers the target id over the kind for non-host surface ids", () => {
    const session = toCanonicalInteractionSession(
      snapshot({
        isolationMode: "managed_browser",
        target: { kind: "browser", targetId: "tab-42" },
      }),
    );
    expect(session.surfaces[0]?.kind).toBe("browser_tab");
    expect(session.surfaces[0]?.surfaceId).toBe("tab-42");
    expect(session.profileMode).toBe("managed");
  });

  it("falls back to the target kind when no target id is present", () => {
    const session = toCanonicalInteractionSession(
      snapshot({
        isolationMode: "managed_browser",
        target: { kind: "browser" },
      }),
    );
    expect(session.surfaces[0]?.surfaceId).toBe("browser");
  });

  it("maps sandbox and remote_guest sessions to virtual_desktop", () => {
    for (const kind of ["sandbox", "remote_guest"] as const) {
      const session = toCanonicalInteractionSession(
        snapshot({
          isolationMode: "virtual_display",
          target: { kind, targetId: "vd-1" },
        }),
      );
      expect(session.surfaces[0]?.kind).toBe("virtual_desktop");
      expect(session.surfaces[0]?.surfaceId).toBe("vd-1");
      expect(session.profileMode).toBe("none");
    }
  });

  it("carries lease expiry through to the canonical expiresAt", () => {
    const session = toCanonicalInteractionSession(
      snapshot({ leaseExpiresAt: "2026-08-25T01:00:00.000Z" }),
    );
    expect(session.expiresAt).toBe("2026-08-25T01:00:00.000Z");
  });
});

describe("authorizeCompatibilitySessionAction — pointer mapping", () => {
  it("maps click onto the canonical click kind with the pointer payload", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({ command: "click", parameters: { coordinate: [100, 200] } }),
    );
    expect(mapped.kind).toBe("click");
    expect(mapped.payload).toEqual({
      elementId: null,
      point: { x: 100, y: 200 },
    });
  });

  it("keeps click and double_click distinct kinds", async () => {
    const single = await mappedDispatch(
      snapshot(),
      action({ command: "click" }),
    );
    const double = await mappedDispatch(
      snapshot(),
      action({ command: "double_click" }),
    );
    const context = await mappedDispatch(
      snapshot(),
      action({ command: "right_click" }),
    );
    expect(single.kind).toBe("click");
    expect(double.kind).toBe("double_click");
    expect(context.kind).toBe("context_click");
  });

  it("maps mouse_move onto hover and accepts x/y keys with an element ref", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({ command: "mouse_move", parameters: { x: 5, y: 6, ref: "btn" } }),
    );
    expect(mapped.kind).toBe("hover");
    expect(mapped.payload).toEqual({
      elementId: "btn",
      point: { x: 5, y: 6 },
    });
  });

  it("maps element_index to the element_index: id form", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({ command: "click", parameters: { element_index: 4 } }),
    );
    expect(mapped.payload).toEqual({
      elementId: "element_index:4",
      point: null,
    });
  });

  it("maps drag from a path array start/end", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({
        command: "drag",
        parameters: {
          path: [
            [1, 2],
            [3, 4],
          ],
        },
      }),
    );
    expect(mapped.kind).toBe("drag");
    expect(mapped.payload).toEqual({
      fromElementId: null,
      toElementId: null,
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
    });
  });

  it("falls back to startCoordinate/x1,y1 when no path is given", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({
        command: "drag",
        parameters: {
          startCoordinate: [9, 8],
          coordinate: [7, 6],
        },
      }),
    );
    expect(mapped.payload).toEqual({
      fromElementId: null,
      toElementId: null,
      from: { x: 9, y: 8 },
      to: { x: 7, y: 6 },
    });
  });

  it("maps scroll directions onto signed deltas with an absolute amount", async () => {
    const up = await mappedDispatch(
      snapshot(),
      action({
        command: "scroll",
        parameters: { direction: "up", amount: 50 },
      }),
    );
    expect(up.kind).toBe("scroll");
    expect(up.payload).toEqual({
      deltaX: 0,
      deltaY: -50,
      elementId: null,
    });
    const left = await mappedDispatch(
      snapshot(),
      action({ command: "scroll", parameters: { direction: "left" } }),
    );
    expect(left.payload).toEqual({
      deltaX: -300,
      deltaY: 0,
      elementId: null,
    });
    const right = await mappedDispatch(
      snapshot(),
      action({
        command: "scroll",
        parameters: { direction: "right", amount: 10 },
      }),
    );
    expect(right.payload).toEqual({
      deltaX: 10,
      deltaY: 0,
      elementId: null,
    });
  });
});

describe("authorizeCompatibilitySessionAction — observation and text mapping", () => {
  it("maps observation verbs onto the observe kind with empty payloads", async () => {
    for (const command of [
      "screenshot",
      "browser_dom",
      "ocr",
      "get_cursor_position",
    ]) {
      const mapped = await mappedDispatch(
        snapshot(),
        action({ command, parameters: {} }),
      );
      expect(mapped.kind).toBe("observe");
      expect(mapped.payload).toEqual({});
    }
  });

  it("maps type onto type_text carrying text and the sensitivity flag", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({
        command: "type",
        parameters: { text: "hello", sensitive: true },
      }),
    );
    expect(mapped.kind).toBe("type_text");
    expect(mapped.payload).toEqual({
      text: "hello",
      elementId: null,
      sensitive: true,
    });
    const plain = await mappedDispatch(
      snapshot(),
      action({ command: "set_value", parameters: { value: "v" } }),
    );
    expect(plain.kind).toBe("set_value");
    expect(plain.payload).toEqual({
      text: "v",
      elementId: null,
      sensitive: false,
    });
  });

  it("maps key_press onto press_key with modifiers joined in order", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({
        command: "key_press",
        parameters: { modifiers: ["ctrl", "shift", "a"] },
      }),
    );
    expect(mapped.kind).toBe("press_key");
    expect(mapped.payload).toEqual({ key: "ctrl+shift+a" });
  });
});

describe("authorizeCompatibilitySessionAction — window, app, and browser mapping", () => {
  it("maps window focus verbs onto focus with the window element id", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({ command: "minimize_window", parameters: { windowId: "w-1" } }),
    );
    expect(mapped.kind).toBe("focus");
    expect(mapped.payload).toEqual({ elementId: "w-1" });
  });

  it("maps launch and kill_app onto their app kinds", async () => {
    const launch = await mappedDispatch(
      snapshot(),
      action({ command: "launch", parameters: { app: "Safari" } }),
    );
    expect(launch.kind).toBe("launch_app");
    expect(launch.payload).toEqual({ applicationId: "Safari" });
    const kill = await mappedDispatch(
      snapshot(),
      action({ command: "kill_app", parameters: { app: "Safari" } }),
    );
    expect(kill.kind).toBe("quit_app");
    expect(kill.payload).toEqual({ applicationId: "Safari" });
  });

  it("maps open onto the open kind with the target url", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({ command: "open", parameters: { target: "https://eliza.os" } }),
    );
    expect(mapped.kind).toBe("open");
    expect(mapped.payload).toEqual({ url: "https://eliza.os" });
  });

  it("maps browser tab management verbs", async () => {
    const tab = await mappedDispatch(
      snapshot(),
      action({ command: "browser_switch_tab", parameters: { tabId: "t-9" } }),
    );
    expect(tab.kind).toBe("switch_tab");
    expect(tab.payload).toEqual({ tabId: "t-9" });
    const close = await mappedDispatch(
      snapshot(),
      action({ command: "browser_close_tab", parameters: {} }),
    );
    expect(close.kind).toBe("close_tab");
    expect(close.payload).toEqual({});
  });

  it("splits browser_open by url presence into navigate vs launch_app", async () => {
    const nav = await mappedDispatch(
      snapshot(),
      action({
        command: "browser_open",
        parameters: { url: "https://eliza.os" },
      }),
    );
    expect(nav.kind).toBe("navigate");
    expect(nav.payload).toEqual({ url: "https://eliza.os" });
    const launch = await mappedDispatch(
      snapshot(),
      action({ command: "browser_open", parameters: {} }),
    );
    expect(launch.kind).toBe("launch_app");
    expect(launch.payload).toEqual({ applicationId: "managed-browser" });
  });

  it("maps browser_wait with its timeout default", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({ command: "browser_wait", parameters: { waitForText: "Ready" } }),
    );
    expect(mapped.kind).toBe("wait");
    expect(mapped.payload).toEqual({
      condition: "Ready",
      timeoutMs: 10_000,
    });
  });
});

describe("authorizeCompatibilitySessionAction — browser target authority", () => {
  const browserSession = snapshot({
    isolationMode: "managed_browser",
    target: { kind: "browser", targetId: "tab-42" },
  });

  it("authorizes a browser click through the browser_tab surface", async () => {
    const mapped = await mappedDispatch(
      browserSession,
      action({ command: "browser_click", parameters: { coordinate: [1, 2] } }),
    );
    expect(mapped.kind).toBe("click");
  });

  it("authorizes browser navigation on the browser target", async () => {
    const mapped = await mappedDispatch(
      browserSession,
      action({
        command: "browser_navigate",
        parameters: { url: "https://eliza.os/docs" },
      }),
    );
    expect(mapped.kind).toBe("navigate");
    expect(mapped.payload).toEqual({ url: "https://eliza.os/docs" });
  });
});

describe("authorizeCompatibilitySessionAction — opaque and unknown verbs", () => {
  it("wraps sandbox commands verbatim as evaluate payloads", async () => {
    const mapped = await mappedDispatch(
      snapshot({
        isolationMode: "virtual_display",
        target: { kind: "sandbox", targetId: "sbx" },
      }),
      action({ command: "provider_verb", parameters: { a: 1 } }),
    );
    expect(mapped.kind).toBe("evaluate");
    expect(mapped.payload).toEqual({
      expression: '{"command":"provider_verb","parameters":{"a":1}}',
    });
  });

  it("wraps remote_guest commands identically", async () => {
    const mapped = await mappedDispatch(
      snapshot({
        isolationMode: "remote_session",
        target: { kind: "remote_guest", targetId: "rg" },
      }),
      action({ command: "anything", parameters: {} }),
    );
    expect(mapped.kind).toBe("evaluate");
    expect(mapped.payload).toEqual({
      expression: '{"command":"anything","parameters":{}}',
    });
  });

  it("routes unknown host verbs onto the generic evaluate seam preserving the request", async () => {
    const mapped = await mappedDispatch(
      snapshot(),
      action({ command: "provider_custom_verb", parameters: { z: 1 } }),
    );
    expect(mapped.kind).toBe("evaluate");
    expect(mapped.payload).toEqual({
      expression: '{"command":"provider_custom_verb","parameters":{"z":1}}',
    });
  });
});

describe("authorizeCompatibilitySessionAction — authorization outcomes", () => {
  it("rejects dispatch on a stopped session with the typed contract error", async () => {
    await expect(
      authorizeCompatibilitySessionAction(
        snapshot({ canonicalState: "stopped" }),
        action(),
        Math.floor(NOW),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INTERACTION_CONTRACT",
      message: "Interaction session is not executable.",
    });
  });

  it("rejects dispatch on a paused session", async () => {
    await expect(
      authorizeCompatibilitySessionAction(
        snapshot({ canonicalState: "paused" }),
        action(),
        Math.floor(NOW),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INTERACTION_CONTRACT",
      message: "Interaction session is not executable.",
    });
  });

  it("rejects dispatch after the host lease has expired", async () => {
    await expect(
      authorizeCompatibilitySessionAction(
        snapshot({ leaseExpiresAt: "2026-08-25T00:30:00.000Z" }),
        action(),
        Math.floor(Date.parse(T0) + 45 * 60_000),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INTERACTION_CONTRACT",
      message: "Interaction session is expired.",
    });
  });

  it("rejects an action that predates its session", async () => {
    await expect(
      authorizeCompatibilitySessionAction(
        snapshot({
          createdAt: "2026-08-25T00:01:00.000Z",
          updatedAt: "2026-08-25T00:01:00.000Z",
        }),
        action(),
        Math.floor(Date.parse(T0) + 30_000),
      ),
    ).rejects.toThrow("predates its session");
  });

  it("delegates non-executable sessions to the core authority, which rejects them", async () => {
    const { authorizeInteractionDispatch } = await import("@elizaos/core");
    const spy = vi.mocked(authorizeInteractionDispatch);
    spy.mockClear();
    await expect(
      authorizeCompatibilitySessionAction(
        snapshot({ canonicalState: "stopped" }),
        action(),
        Math.floor(NOW),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INTERACTION_CONTRACT" });
    // The compat layer does not pre-filter: the core authority itself is the
    // single rejection point for non-executable session state.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
