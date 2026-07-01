// @vitest-environment jsdom
//
// Behavioral test for the "Updates" settings section. settings-sections.ts maps
// the `updates` section to <ReleaseCenterView /> (there is no UpdatesSection.tsx),
// so this exercises the component that actually mounts.
//
// Collaborators mocked: the desktop update bridge (invokeDesktopBridgeRequest /
// isElectrobunRuntime / subscribeDesktopBridgeEvent), the app-updates service
// (getApplicationUpdateSnapshot), the app store selector, branding, agent-surface,
// and the utils barrels. The unit under test — ReleaseCenterView — is NOT mocked.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { DesktopUpdaterSnapshot } from "../release-center/types";

type BridgeRequest = { rpcMethod: string; ipcChannel: string; params?: unknown };

const h = vi.hoisted(() => {
  const store = {
    loadUpdateStatus: vi.fn(async (_force?: boolean) => {}),
    // Stable ref (used in effect deps via the selector) — honor defaultValue.
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts && "defaultValue" in opts ? (opts.defaultValue as string) : key,
    updateLoading: false as boolean,
    updateStatus: null as unknown,
  };
  return {
    store,
    invoke: vi.fn<(opts: BridgeRequest) => Promise<unknown>>(),
    subscribe: vi.fn(() => () => {}),
    isDesktop: { value: true },
    appSnapshot: {
      value: {
        appName: "Eliza",
        appId: null,
        version: "1.2.3",
        build: "456",
        platform: "desktop",
        buildVariant: "direct",
        statusLabel: "Direct download",
        canManualCheck: true,
        canAutoUpdate: true,
      } as unknown,
    },
  };
});

vi.mock("../../state", () => ({
  useAppSelectorShallow: (sel: (s: typeof h.store) => unknown) => sel(h.store),
}));

vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: h.invoke,
  isElectrobunRuntime: () => h.isDesktop.value,
  subscribeDesktopBridgeEvent: h.subscribe,
}));

vi.mock("../../config/branding", () => ({
  useBranding: () => ({ appUrl: "https://app.example.com" }),
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../utils", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../../utils/desktop-workspace", () => ({
  openDesktopSurfaceWindow: vi.fn(),
}));

vi.mock("../../services/app-updates/update-policy", async (orig) => {
  const actual =
    await orig<typeof import("../../services/app-updates/update-policy")>();
  return {
    ...actual,
    getApplicationUpdateSnapshot: vi.fn(async () => h.appSnapshot.value),
  };
});

import { ReleaseCenterView } from "./ReleaseCenterView";

const upToDate: DesktopUpdaterSnapshot = {
  currentVersion: "1.2.3",
  channel: "stable",
  baseUrl: "https://app.example.com",
  canAutoUpdate: true,
  updateAvailable: false,
  updateReady: false,
};

// Mutable per-test bridge behavior (plain lets are fine — referenced only from
// the implementation installed in beforeEach, not from a vi.mock factory).
let getStateSnapshot: DesktopUpdaterSnapshot | null = upToDate;
let checkImpl: (opts: BridgeRequest) => Promise<unknown> = async () => upToDate;
let applyImpl: (opts: BridgeRequest) => Promise<unknown> = async () => undefined;

beforeEach(() => {
  h.store.loadUpdateStatus.mockClear();
  h.store.updateLoading = false;
  h.store.updateStatus = null;
  h.isDesktop.value = true;
  getStateSnapshot = upToDate;
  checkImpl = async () => upToDate;
  applyImpl = async () => undefined;
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (opts: BridgeRequest) => {
    switch (opts.rpcMethod) {
      case "desktopGetUpdaterState":
        return getStateSnapshot;
      case "desktopCheckForUpdates":
        return checkImpl(opts);
      case "desktopApplyUpdate":
        return applyImpl(opts);
      default:
        return null;
    }
  });
});

afterEach(() => cleanup());

async function renderSettled() {
  await act(async () => {
    render(<ReleaseCenterView />);
  });
  // Flush chained mount effects: getState -> setNativeUpdater ->
  // getApplicationUpdateSnapshot -> setApplicationUpdate.
  await act(async () => {});
}

function checkCalls() {
  return h.invoke.mock.calls.filter(
    ([o]) => o.rpcMethod === "desktopCheckForUpdates",
  );
}

describe("ReleaseCenterView (updates settings section)", () => {
  it("loads agent update status and queries the desktop updater state on mount", async () => {
    await renderSettled();

    expect(h.store.loadUpdateStatus).toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ rpcMethod: "desktopGetUpdaterState" }),
    );
    // Up-to-date snapshot -> "Idle" status, no attention warning.
    expect(screen.getByText("Idle")).toBeTruthy();
  });

  it("fires desktopCheckForUpdates with the exact bridge payload and shows the started message", async () => {
    await renderSettled();

    fireEvent.click(
      screen.getByRole("button", { name: "Check / Download Update" }),
    );
    await act(async () => {});

    expect(checkCalls()).toHaveLength(1);
    expect(h.invoke).toHaveBeenCalledWith({
      rpcMethod: "desktopCheckForUpdates",
      ipcChannel: "desktop:checkForUpdates",
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Desktop update check started.");
  });

  it("renders the update-available state and hides Apply until an update is downloaded", async () => {
    getStateSnapshot = {
      ...upToDate,
      updateAvailable: true,
      updateReady: false,
    };
    await renderSettled();

    expect(screen.getByText("Update available")).toBeTruthy();
    // Apply button must not exist while the update is only available, not ready.
    expect(
      screen.queryByRole("button", { name: "Apply Downloaded Update" }),
    ).toBeNull();
  });

  it("shows the Apply action once the update is ready and fires desktopApplyUpdate", async () => {
    getStateSnapshot = { ...upToDate, updateAvailable: true, updateReady: true };
    await renderSettled();

    const apply = screen.getByRole("button", {
      name: "Apply Downloaded Update",
    });
    fireEvent.click(apply);
    await act(async () => {});

    expect(h.invoke).toHaveBeenCalledWith({
      rpcMethod: "desktopApplyUpdate",
      ipcChannel: "desktop:applyUpdate",
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Applying downloaded update.");
  });

  it("surfaces a bridge failure as an alert and does not show a success message", async () => {
    checkImpl = async () => {
      throw new Error("updater offline");
    };
    await renderSettled();

    fireEvent.click(
      screen.getByRole("button", { name: "Check / Download Update" }),
    );
    await act(async () => {});

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("updater offline");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disables the check button while a store-level update load is in flight", async () => {
    h.store.updateLoading = true;
    await renderSettled();

    const button = screen.getByRole("button", {
      name: "Check / Download Update",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("is idempotent under a rapid double-click: only one check request fires while busy", async () => {
    let resolveCheck: (v: unknown) => void = () => {};
    checkImpl = () =>
      new Promise((resolve) => {
        resolveCheck = resolve;
      });
    await renderSettled();

    const button = screen.getByRole("button", {
      name: "Check / Download Update",
    }) as HTMLButtonElement;

    fireEvent.click(button);
    // First click flips busyAction -> the button disables before the 2nd click.
    expect(button.disabled).toBe(true);
    fireEvent.click(button);

    expect(checkCalls()).toHaveLength(1);

    await act(async () => {
      resolveCheck(upToDate);
    });
    // After completion the button re-enables.
    expect(button.disabled).toBe(false);
  });
});
