// @vitest-environment jsdom
/**
 * Behavioral coverage for the Remote Plugin Host manager — a HIGH-RISK surface
 * (an installed remote plugin "can call the app API as you"). We drive the real
 * component and mock only the desktop-bridge boundary, asserting:
 *  - install sends the exact typed payload to the bridge, then refreshes,
 *  - start/stop route to the right worker RPC with the plugin id,
 *  - logs toggle fetches + renders bridge log text,
 *  - uninstall is GATED behind window.confirm (declining must NOT fire the
 *    destructive RPC; confirming fires it exactly once then refreshes),
 *  - the two live bridge subscriptions subscribe on mount, an event mutates the
 *    shown state, and both unsubscribe on unmount.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopInstalledRemotePluginSnapshot,
  DesktopRemotePluginStoreSnapshot,
  DesktopRemotePluginWorkerStatus,
} from "../../bridge/electrobun-rpc";

const mocks = vi.hoisted(() => ({
  getDesktopRemotePluginStoreSnapshot: vi.fn(),
  listDesktopRemotePluginWorkerStatuses: vi.fn(),
  getDesktopRemotePluginStoreRoot: vi.fn(),
  getDesktopRemotePluginLogs: vi.fn(),
  installDesktopRemotePluginFromDirectory: vi.fn(),
  uninstallDesktopRemotePlugin: vi.fn(),
  startDesktopRemotePluginWorker: vi.fn(),
  stopDesktopRemotePluginWorker: vi.fn(),
  pickDesktopWorkspaceFolder: vi.fn(),
  desktopOpenPath: vi.fn(),
  // Subscription plumbing: capture the listeners so a test can push an event,
  // and expose the off() spies so we can assert unsubscribe-on-unmount.
  storeListener: null as
    | ((snap: DesktopRemotePluginStoreSnapshot) => void)
    | null,
  workerListener: null as
    | ((status: DesktopRemotePluginWorkerStatus) => void)
    | null,
  offStore: vi.fn(),
  offWorker: vi.fn(),
  subscribeDesktopRemotePluginStoreChanged: vi.fn(),
  subscribeDesktopRemotePluginWorkerChanged: vi.fn(),
}));

mocks.subscribeDesktopRemotePluginStoreChanged.mockImplementation(
  (listener: (snap: DesktopRemotePluginStoreSnapshot) => void) => {
    mocks.storeListener = listener;
    return mocks.offStore;
  },
);
mocks.subscribeDesktopRemotePluginWorkerChanged.mockImplementation(
  (listener: (status: DesktopRemotePluginWorkerStatus) => void) => {
    mocks.workerListener = listener;
    return mocks.offWorker;
  },
);

vi.mock("../../bridge/electrobun-rpc", () => ({
  getDesktopRemotePluginStoreSnapshot: mocks.getDesktopRemotePluginStoreSnapshot,
  listDesktopRemotePluginWorkerStatuses:
    mocks.listDesktopRemotePluginWorkerStatuses,
  getDesktopRemotePluginStoreRoot: mocks.getDesktopRemotePluginStoreRoot,
  getDesktopRemotePluginLogs: mocks.getDesktopRemotePluginLogs,
  installDesktopRemotePluginFromDirectory:
    mocks.installDesktopRemotePluginFromDirectory,
  uninstallDesktopRemotePlugin: mocks.uninstallDesktopRemotePlugin,
  startDesktopRemotePluginWorker: mocks.startDesktopRemotePluginWorker,
  stopDesktopRemotePluginWorker: mocks.stopDesktopRemotePluginWorker,
  pickDesktopWorkspaceFolder: mocks.pickDesktopWorkspaceFolder,
  desktopOpenPath: mocks.desktopOpenPath,
  subscribeDesktopRemotePluginStoreChanged:
    mocks.subscribeDesktopRemotePluginStoreChanged,
  subscribeDesktopRemotePluginWorkerChanged:
    mocks.subscribeDesktopRemotePluginWorkerChanged,
}));

import { RemotePluginHostSection } from "./RemotePluginHostSection";

function makePlugin(
  id: string,
  overrides: Partial<DesktopInstalledRemotePluginSnapshot> = {},
): DesktopInstalledRemotePluginSnapshot {
  return {
    id,
    name: `Plugin ${id}`,
    description: `desc ${id}`,
    version: "1.0.0",
    mode: "background",
    status: "installed",
    sourceKind: "local",
    currentHash: "hash",
    installedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    devMode: false,
    lastBuildAt: null,
    lastBuildError: null,
    requestedPermissions: { host: { storage: true }, bun: { read: true } },
    grantedPermissions: { host: { storage: true }, bun: { read: true } },
    view: {
      relativePath: "index.html",
      title: "View",
      width: 400,
      height: 300,
      viewUrl: "app://view",
    },
    worker: { relativePath: "worker.js" },
    ...overrides,
  };
}

function snapshotOf(
  plugins: DesktopInstalledRemotePluginSnapshot[],
): DesktopRemotePluginStoreSnapshot {
  return { version: 1, remotePlugins: plugins };
}

function workerStatus(
  id: string,
  state: DesktopRemotePluginWorkerStatus["state"],
  error: string | null = null,
): DesktopRemotePluginWorkerStatus {
  return { id, state, startedAt: null, stoppedAt: null, error };
}

/** Default: bridge reachable, one installed plugin, no workers running. */
function primeBridge(plugins: DesktopInstalledRemotePluginSnapshot[]) {
  mocks.getDesktopRemotePluginStoreSnapshot.mockResolvedValue(
    snapshotOf(plugins),
  );
  mocks.listDesktopRemotePluginWorkerStatuses.mockResolvedValue([]);
  mocks.getDesktopRemotePluginStoreRoot.mockResolvedValue("/store/root");
}

const q = (root: HTMLElement, agentId: string) =>
  root.querySelector<HTMLElement>(`[data-agent-id="${agentId}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeListener = null;
  mocks.workerListener = null;
  mocks.subscribeDesktopRemotePluginStoreChanged.mockImplementation(
    (listener: (snap: DesktopRemotePluginStoreSnapshot) => void) => {
      mocks.storeListener = listener;
      return mocks.offStore;
    },
  );
  mocks.subscribeDesktopRemotePluginWorkerChanged.mockImplementation(
    (listener: (status: DesktopRemotePluginWorkerStatus) => void) => {
      mocks.workerListener = listener;
      return mocks.offWorker;
    },
  );
});

afterEach(() => {
  cleanup();
});

describe("RemotePluginHostSection", () => {
  it("loads the store snapshot on mount and lists installed plugins", async () => {
    primeBridge([makePlugin("alpha")]);
    const { container } = render(<RemotePluginHostSection />);

    await waitFor(() => {
      expect(container.textContent).toContain("Plugin alpha");
    });
    // Refresh fanned out to all three read endpoints exactly once.
    expect(
      mocks.getDesktopRemotePluginStoreSnapshot,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.listDesktopRemotePluginWorkerStatuses).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.getDesktopRemotePluginStoreRoot).toHaveBeenCalledTimes(1);
    // Store root is surfaced as the reveal-in-file-manager affordance.
    expect(container.textContent).toContain("/store/root");
  });

  it("shows the empty state when no plugins are installed", async () => {
    primeBridge([]);
    const { container } = render(<RemotePluginHostSection />);
    await waitFor(() => {
      expect(container.textContent).toContain("No remote plugins installed.");
    });
  });

  it("install sends the exact typed payload then refreshes", async () => {
    primeBridge([]);
    mocks.installDesktopRemotePluginFromDirectory.mockResolvedValue(
      makePlugin("beta"),
    );
    const { container } = render(<RemotePluginHostSection />);
    await waitFor(() =>
      expect(mocks.getDesktopRemotePluginStoreSnapshot).toHaveBeenCalled(),
    );

    const input = q(container, "remote-plugin-source-dir") as HTMLInputElement;
    const installBtn = q(
      container,
      "remote-plugin-install",
    ) as HTMLButtonElement;

    // Install is disabled until a source dir is provided.
    expect(installBtn.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "  /path/to/plugin  " } });
    await waitFor(() => expect(installBtn.disabled).toBe(false));

    // After install, the store is re-read (refresh). Point the snapshot at the
    // new plugin so we can prove the refresh ran.
    mocks.getDesktopRemotePluginStoreSnapshot.mockResolvedValue(
      snapshotOf([makePlugin("beta")]),
    );
    installBtn.click();

    await waitFor(() =>
      expect(
        mocks.installDesktopRemotePluginFromDirectory,
      ).toHaveBeenCalledTimes(1),
    );
    // Trimmed sourceDir + devMode:true — the exact contract to the bridge.
    expect(
      mocks.installDesktopRemotePluginFromDirectory,
    ).toHaveBeenCalledWith({ sourceDir: "/path/to/plugin", devMode: true });

    // Refresh re-read the snapshot and the new plugin appears; input cleared.
    await waitFor(() => {
      expect(container.textContent).toContain("Plugin beta");
    });
    expect(input.value).toBe("");
  });

  it("blank / whitespace-only source dir never calls the install bridge", async () => {
    primeBridge([]);
    const { container } = render(<RemotePluginHostSection />);
    await waitFor(() =>
      expect(mocks.getDesktopRemotePluginStoreSnapshot).toHaveBeenCalled(),
    );

    const input = q(container, "remote-plugin-source-dir") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });

    // Even if we force-click the (disabled) button handler, the guard holds.
    const installBtn = q(
      container,
      "remote-plugin-install",
    ) as HTMLButtonElement;
    installBtn.click();
    await Promise.resolve();
    expect(
      mocks.installDesktopRemotePluginFromDirectory,
    ).not.toHaveBeenCalled();
  });

  it("surfaces the bridge-unavailable install failure", async () => {
    primeBridge([]);
    // null return == desktop bridge not connected.
    mocks.installDesktopRemotePluginFromDirectory.mockResolvedValue(null);
    const { container } = render(<RemotePluginHostSection />);
    await waitFor(() =>
      expect(mocks.getDesktopRemotePluginStoreSnapshot).toHaveBeenCalled(),
    );

    const input = q(container, "remote-plugin-source-dir") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/x" } });
    const installBtn = q(
      container,
      "remote-plugin-install",
    ) as HTMLButtonElement;
    await waitFor(() => expect(installBtn.disabled).toBe(false));
    installBtn.click();

    await waitFor(() => {
      expect(container.textContent).toContain("Install failed");
    });
    // A failed install must NOT clear the field or trigger a second refresh.
    expect(input.value).toBe("/x");
  });

  it("start routes to the start worker RPC with the plugin id", async () => {
    primeBridge([makePlugin("alpha")]);
    mocks.startDesktopRemotePluginWorker.mockResolvedValue(
      workerStatus("alpha", "starting"),
    );
    const { container } = render(<RemotePluginHostSection />);
    await waitFor(() => expect(container.textContent).toContain("Plugin alpha"));

    const toggle = q(
      container,
      "remote-plugin-toggle-alpha",
    ) as HTMLButtonElement;
    // stopped → the toggle is a "Start" control.
    expect(toggle.textContent).toContain("Start");
    toggle.click();

    await waitFor(() =>
      expect(mocks.startDesktopRemotePluginWorker).toHaveBeenCalledWith(
        "alpha",
      ),
    );
    expect(mocks.stopDesktopRemotePluginWorker).not.toHaveBeenCalled();
  });

  it("a running worker shows Stop and routes to the stop worker RPC", async () => {
    mocks.getDesktopRemotePluginStoreSnapshot.mockResolvedValue(
      snapshotOf([makePlugin("alpha")]),
    );
    mocks.listDesktopRemotePluginWorkerStatuses.mockResolvedValue([
      workerStatus("alpha", "running"),
    ]);
    mocks.getDesktopRemotePluginStoreRoot.mockResolvedValue("/store/root");
    mocks.stopDesktopRemotePluginWorker.mockResolvedValue(
      workerStatus("alpha", "stopped"),
    );

    const { container } = render(<RemotePluginHostSection />);
    await waitFor(() => {
      const toggle = q(container, "remote-plugin-toggle-alpha");
      expect(toggle?.textContent).toContain("Stop");
    });
    // running state badge is rendered.
    expect(container.textContent).toContain("running");

    (q(container, "remote-plugin-toggle-alpha") as HTMLButtonElement).click();
    await waitFor(() =>
      expect(mocks.stopDesktopRemotePluginWorker).toHaveBeenCalledWith("alpha"),
    );
    expect(mocks.startDesktopRemotePluginWorker).not.toHaveBeenCalled();
  });

  it("logs toggle fetches and renders bridge log text, then hides on re-toggle", async () => {
    primeBridge([makePlugin("alpha")]);
    mocks.getDesktopRemotePluginLogs.mockResolvedValue({
      id: "alpha",
      path: "/logs/alpha.log",
      text: "boot line one\nboot line two",
      truncated: false,
    });
    const { container } = render(<RemotePluginHostSection />);
    await waitFor(() => expect(container.textContent).toContain("Plugin alpha"));

    const logsBtn = q(
      container,
      "remote-plugin-logs-alpha",
    ) as HTMLButtonElement;
    logsBtn.click();

    await waitFor(() => {
      expect(container.textContent).toContain("boot line one");
    });
    expect(mocks.getDesktopRemotePluginLogs).toHaveBeenCalledWith("alpha");

    // Re-toggle collapses the pane without re-fetching.
    logsBtn.click();
    await waitFor(() => {
      expect(container.textContent).not.toContain("boot line one");
    });
    expect(mocks.getDesktopRemotePluginLogs).toHaveBeenCalledTimes(1);
  });

  describe("uninstall confirm gate (destructive)", () => {
    it("declining the confirm does NOT fire the uninstall RPC", async () => {
      primeBridge([makePlugin("alpha")]);
      const confirmSpy = vi
        .spyOn(window, "confirm")
        .mockReturnValue(false);
      const { container } = render(<RemotePluginHostSection />);
      await waitFor(() =>
        expect(container.textContent).toContain("Plugin alpha"),
      );

      (
        q(container, "remote-plugin-uninstall-alpha") as HTMLButtonElement
      ).click();
      await Promise.resolve();

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(mocks.uninstallDesktopRemotePlugin).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("confirming fires the uninstall RPC exactly once then refreshes", async () => {
      primeBridge([makePlugin("alpha")]);
      mocks.uninstallDesktopRemotePlugin.mockResolvedValue({
        removed: true,
        remotePlugin: null,
      });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const { container } = render(<RemotePluginHostSection />);
      await waitFor(() =>
        expect(container.textContent).toContain("Plugin alpha"),
      );
      const snapshotCallsBefore =
        mocks.getDesktopRemotePluginStoreSnapshot.mock.calls.length;

      // Point the post-uninstall refresh at an empty store.
      mocks.getDesktopRemotePluginStoreSnapshot.mockResolvedValue(
        snapshotOf([]),
      );
      (
        q(container, "remote-plugin-uninstall-alpha") as HTMLButtonElement
      ).click();

      await waitFor(() =>
        expect(mocks.uninstallDesktopRemotePlugin).toHaveBeenCalledWith(
          "alpha",
        ),
      );
      expect(mocks.uninstallDesktopRemotePlugin).toHaveBeenCalledTimes(1);
      // Refresh ran after uninstall → plugin gone from the list.
      await waitFor(() => {
        expect(container.textContent).toContain("No remote plugins installed.");
      });
      expect(
        mocks.getDesktopRemotePluginStoreSnapshot.mock.calls.length,
      ).toBeGreaterThan(snapshotCallsBefore);
      confirmSpy.mockRestore();
    });

    it("rapid double-click with confirm declined still fires zero destructive RPCs", async () => {
      primeBridge([makePlugin("alpha")]);
      const confirmSpy = vi
        .spyOn(window, "confirm")
        .mockReturnValue(false);
      const { container } = render(<RemotePluginHostSection />);
      await waitFor(() =>
        expect(container.textContent).toContain("Plugin alpha"),
      );

      const btn = q(
        container,
        "remote-plugin-uninstall-alpha",
      ) as HTMLButtonElement;
      btn.click();
      btn.click();
      btn.click();
      await Promise.resolve();

      expect(confirmSpy).toHaveBeenCalledTimes(3);
      expect(mocks.uninstallDesktopRemotePlugin).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });
  });

  describe("live bridge subscriptions", () => {
    it("subscribes to both channels on mount and unsubscribes on unmount", async () => {
      primeBridge([makePlugin("alpha")]);
      const { unmount, container } = render(<RemotePluginHostSection />);
      await waitFor(() =>
        expect(container.textContent).toContain("Plugin alpha"),
      );

      expect(
        mocks.subscribeDesktopRemotePluginStoreChanged,
      ).toHaveBeenCalledTimes(1);
      expect(
        mocks.subscribeDesktopRemotePluginWorkerChanged,
      ).toHaveBeenCalledTimes(1);
      expect(mocks.offStore).not.toHaveBeenCalled();
      expect(mocks.offWorker).not.toHaveBeenCalled();

      unmount();

      expect(mocks.offStore).toHaveBeenCalledTimes(1);
      expect(mocks.offWorker).toHaveBeenCalledTimes(1);
    });

    it("a store-changed event replaces the shown plugin list", async () => {
      primeBridge([makePlugin("alpha")]);
      const { container } = render(<RemotePluginHostSection />);
      await waitFor(() =>
        expect(container.textContent).toContain("Plugin alpha"),
      );

      // Bridge pushes a new store snapshot (e.g. a plugin installed elsewhere).
      mocks.storeListener?.(snapshotOf([makePlugin("gamma")]));

      await waitFor(() => {
        expect(container.textContent).toContain("Plugin gamma");
      });
      expect(container.textContent).not.toContain("Plugin alpha");
    });

    it("a worker-changed event flips the row state and toggle control", async () => {
      primeBridge([makePlugin("alpha")]);
      const { container } = render(<RemotePluginHostSection />);
      await waitFor(() =>
        expect(container.textContent).toContain("Plugin alpha"),
      );
      // Baseline: stopped → Start control.
      expect(
        q(container, "remote-plugin-toggle-alpha")?.textContent,
      ).toContain("Start");

      mocks.workerListener?.(workerStatus("alpha", "running"));

      await waitFor(() => {
        expect(
          q(container, "remote-plugin-toggle-alpha")?.textContent,
        ).toContain("Stop");
      });
      expect(container.textContent).toContain("running");
    });

    it("a worker-changed error event surfaces the worker error text", async () => {
      primeBridge([makePlugin("alpha")]);
      const { container } = render(<RemotePluginHostSection />);
      await waitFor(() =>
        expect(container.textContent).toContain("Plugin alpha"),
      );

      mocks.workerListener?.(
        workerStatus("alpha", "error", "worker crashed: OOM"),
      );

      await waitFor(() => {
        expect(container.textContent).toContain("worker crashed: OOM");
      });
    });
  });
});
