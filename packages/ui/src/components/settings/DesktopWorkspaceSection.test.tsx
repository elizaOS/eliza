// @vitest-environment jsdom

/**
 * Behavioural coverage for `DesktopWorkspaceSection` — the desktop-only
 * workspace/settings panel (auto-launch toggles, window controls, clipboard
 * draft, native lifecycle actions).
 *
 * The unit under test is the section component itself; the only things mocked
 * are COLLABORATORS across a real seam:
 *   - `../../bridge` (`invokeDesktopBridgeRequest` = the desktop RPC transport,
 *     `isElectrobunRuntime` = the desktop-runtime guard)
 *   - `../../state` (`useAppSelector` → the shell store: `t`, `relaunchDesktop`,
 *     `restartBackend`)
 *   - `../../utils/desktop-workspace` snapshot loader + detached-window openers
 *   - `../../utils/clipboard` copy helper
 *   - `../../api/csrf-client` dev-diagnostics fetch
 *   - `../../agent-surface` instrumentation (inert)
 *
 * Assertions are semantic: the EXACT persisted RPC payload for a toggle, the
 * correct window-control method for the current snapshot, a DOM round-trip on
 * the clipboard draft, error surfacing, and rapid-fire idempotency.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopWorkspaceSnapshot,
  requestDesktopBridge as RequestDesktopBridge,
} from "../../utils/desktop-workspace";

type BridgeRequest = {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
};

const runtimeMock = vi.hoisted(() => ({ desktop: true }));

const bridgeMock = vi.hoisted(() => ({
  invoke: vi.fn<(req: BridgeRequest) => Promise<unknown>>(),
}));

const desktopWorkspaceMock = vi.hoisted(() => ({
  load: vi.fn(),
  openSettings: vi.fn(),
  openSurface: vi.fn(),
}));

const clipboardMock = vi.hoisted(() => ({ copy: vi.fn() }));

const stateMock = vi.hoisted(() => {
  const t = (key: string, options?: Record<string, unknown>): string => {
    if (options && typeof options.defaultValue === "string") {
      let out = options.defaultValue;
      for (const [k, v] of Object.entries(options)) {
        if (k === "defaultValue") continue;
        out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      }
      return out;
    }
    return key;
  };
  return {
    value: {
      t,
      relaunchDesktop: vi.fn(),
      restartBackend: vi.fn(),
    } as {
      t: typeof t;
      relaunchDesktop: ReturnType<typeof vi.fn>;
      restartBackend: ReturnType<typeof vi.fn>;
    },
  };
});

vi.mock("../../bridge", () => ({
  isElectrobunRuntime: () => runtimeMock.desktop,
  invokeDesktopBridgeRequest: (req: BridgeRequest) => bridgeMock.invoke(req),
}));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: typeof stateMock.value) => unknown) =>
    sel(stateMock.value),
}));

// Keep the real surface catalog + summary formatter; only stub the async
// snapshot loader and the detached-window openers.
vi.mock("../../utils/desktop-workspace", async () => {
  const actual = await vi.importActual<
    typeof import("../../utils/desktop-workspace")
  >("../../utils/desktop-workspace");
  return {
    ...actual,
    loadDesktopWorkspaceSnapshot: () => desktopWorkspaceMock.load(),
    openDesktopSettingsWindow: (...args: unknown[]) =>
      desktopWorkspaceMock.openSettings(...args),
    openDesktopSurfaceWindow: (...args: unknown[]) =>
      desktopWorkspaceMock.openSurface(...args),
  } satisfies Partial<typeof actual> & {
    requestDesktopBridge: typeof RequestDesktopBridge;
  };
});

vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: (text: string) => clipboardMock.copy(text),
}));

vi.mock("../../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  })),
}));

// Inert, per-call agent-surface handle. agentProps is empty so a button's
// accessible name is its text content (the i18n key our stub `t` echoes back).
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { DesktopWorkspaceSection } from "./DesktopWorkspaceSection";

function makeSnapshot(
  overrides: Partial<DesktopWorkspaceSnapshot> = {},
): DesktopWorkspaceSnapshot {
  return {
    supported: true,
    version: { version: "1.2.3", name: "Milady", runtime: "electrobun" },
    packaged: true,
    autoLaunch: { enabled: false, openAsHidden: false },
    window: {
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      maximized: false,
      minimized: false,
      visible: true,
      focused: true,
    },
    power: { onBattery: false, idleState: "active", idleTime: 0 },
    primaryDisplay: null,
    displays: [],
    cursor: null,
    clipboard: { text: "seed-clip", hasImage: false, formats: ["text/plain"] },
    paths: { home: "/home/u", downloads: "/home/u/Downloads" },
    ...overrides,
  };
}

function btn(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

async function renderReady(snapshot = makeSnapshot()) {
  desktopWorkspaceMock.load.mockResolvedValue(snapshot);
  const utils = render(<DesktopWorkspaceSection />);
  // Wait until the async snapshot has settled into the tree (auto-launch label
  // depends on it).
  await screen.findByRole("button", {
    name: "desktopworkspacesection.EnableAutoLaunch",
  });
  return utils;
}

describe("DesktopWorkspaceSection", () => {
  beforeEach(() => {
    runtimeMock.desktop = true;
    bridgeMock.invoke.mockReset();
    bridgeMock.invoke.mockResolvedValue(undefined);
    desktopWorkspaceMock.load.mockReset();
    desktopWorkspaceMock.openSettings.mockReset().mockResolvedValue(undefined);
    desktopWorkspaceMock.openSurface.mockReset().mockResolvedValue(undefined);
    clipboardMock.copy.mockReset().mockResolvedValue(undefined);
    stateMock.value.relaunchDesktop = vi.fn();
    stateMock.value.restartBackend = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the non-desktop notice and NO controls when not in the desktop runtime", () => {
    runtimeMock.desktop = false;
    render(<DesktopWorkspaceSection />);

    expect(
      screen.getByText("desktopworkspacesection.DesktopToolsOnlyAvailable"),
    ).toBeTruthy();
    // The snapshot loader is never invoked and no window/lifecycle controls mount.
    expect(desktopWorkspaceMock.load).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: "desktopworkspacesection.EnableAutoLaunch",
      }),
    ).toBeNull();
  });

  it("persists the auto-launch toggle: flips `enabled`, PRESERVES `openAsHidden`", async () => {
    const user = userEvent.setup();
    await renderReady(
      makeSnapshot({ autoLaunch: { enabled: false, openAsHidden: true } }),
    );

    await user.click(btn("desktopworkspacesection.EnableAutoLaunch"));

    await waitFor(() => {
      expect(bridgeMock.invoke).toHaveBeenCalledWith({
        rpcMethod: "desktopSetAutoLaunch",
        ipcChannel: "desktop:setAutoLaunch",
        params: { enabled: true, openAsHidden: true },
      });
    });
  });

  it("persists the hidden-launch toggle: flips `openAsHidden`, PRESERVES `enabled`", async () => {
    const user = userEvent.setup();
    await renderReady(
      makeSnapshot({ autoLaunch: { enabled: true, openAsHidden: false } }),
    );

    await user.click(btn("desktopworkspacesection.LaunchHiddenOnLogin"));

    await waitFor(() => {
      expect(bridgeMock.invoke).toHaveBeenCalledWith({
        rpcMethod: "desktopSetAutoLaunch",
        ipcChannel: "desktop:setAutoLaunch",
        params: { enabled: true, openAsHidden: true },
      });
    });
  });

  it("fires the correct window-control RPC (Show + minimize based on snapshot state)", async () => {
    const user = userEvent.setup();
    await renderReady(); // minimized: false

    await user.click(btn("gameview.ShowWindow"));
    await waitFor(() =>
      expect(bridgeMock.invoke).toHaveBeenCalledWith({
        rpcMethod: "desktopShowWindow",
        ipcChannel: "desktop:showWindow",
      }),
    );

    // window.minimized === false → the toggle must MINIMIZE (not unminimize).
    await user.click(btn("desktopworkspacesection.MinimizeWindow"));
    await waitFor(() =>
      expect(bridgeMock.invoke).toHaveBeenCalledWith({
        rpcMethod: "desktopMinimizeWindow",
        ipcChannel: "desktop:minimizeWindow",
      }),
    );
  });

  it("uses the UNminimize RPC when the window is already minimized", async () => {
    const user = userEvent.setup();
    await renderReady(
      makeSnapshot({
        window: {
          bounds: null,
          maximized: false,
          minimized: true,
          visible: true,
          focused: false,
        },
      }),
    );

    // Label flips to Restore, and the RPC flips to unminimize.
    await user.click(btn("desktopworkspacesection.RestoreWindow"));
    await waitFor(() =>
      expect(bridgeMock.invoke).toHaveBeenCalledWith({
        rpcMethod: "desktopUnminimizeWindow",
        ipcChannel: "desktop:unminimizeWindow",
      }),
    );
  });

  it("round-trips the clipboard draft: typed text is copied verbatim", async () => {
    const user = userEvent.setup();
    await renderReady();

    const draft = screen.getByPlaceholderText(
      "desktopworkspacesection.ClipboardDraft",
    ) as HTMLTextAreaElement;
    await user.clear(draft);
    await user.type(draft, "ship it");
    expect(draft.value).toBe("ship it");

    await user.click(btn("desktopworkspacesection.CopyDraft"));
    await waitFor(() =>
      expect(clipboardMock.copy).toHaveBeenCalledWith("ship it"),
    );
  });

  it("reads the clipboard through the bridge and hydrates the draft from the result", async () => {
    bridgeMock.invoke.mockImplementation(async (req: BridgeRequest) => {
      if (req.rpcMethod === "desktopReadFromClipboard") {
        return { text: "bridged-value" };
      }
      return undefined;
    });
    const user = userEvent.setup();
    await renderReady();

    await user.click(btn("desktopworkspacesection.ReadClipboard"));

    const draft = (await screen.findByDisplayValue(
      "bridged-value",
    )) as HTMLTextAreaElement;
    expect(draft.value).toBe("bridged-value");
    expect(bridgeMock.invoke).toHaveBeenCalledWith({
      rpcMethod: "desktopReadFromClipboard",
      ipcChannel: "desktop:readFromClipboard",
    });
  });

  it("surfaces an alert when a bridge action fails", async () => {
    bridgeMock.invoke.mockRejectedValue(new Error("bridge exploded"));
    const user = userEvent.setup();
    await renderReady();

    await user.click(btn("desktopworkspacesection.EnableAutoLaunch"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("bridge exploded");
  });

  it("is idempotent under rapid double-click: an in-flight action gates further writes", async () => {
    // A never-resolving bridge call keeps the action busy → its button disables.
    bridgeMock.invoke.mockImplementation(() => new Promise<never>(() => {}));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderReady();

    const target = btn("desktopworkspacesection.EnableAutoLaunch");
    await user.click(target);

    await waitFor(() => expect(target.hasAttribute("disabled")).toBe(true));

    // Hammer it — disabled button must not issue a second RPC.
    await user.click(target);
    await user.click(target);

    expect(bridgeMock.invoke).toHaveBeenCalledTimes(1);
  });
});
