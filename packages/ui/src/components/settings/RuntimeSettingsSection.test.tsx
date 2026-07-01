// @vitest-environment jsdom
/**
 * Behavioral coverage for the Settings > Runtime panel.
 *
 * The "runtime setting" here is the deployment-runtime picker (cloud / local /
 * remote). Selecting a mode is the persisted "apply" action: it fires
 * `reloadIntoFirstRunRuntime(target)` — the single setter that clears the active
 * server + reloads into first-run for that target. We drive the REAL component
 * and mock only its collaborators (the runtime-mode snapshot hook, the reload
 * setter, the build-variant guards, and the desktop electrobun bridge),
 * asserting:
 *  - clicking each mode row fires the setter with the EXACT target value,
 *  - the row matching `deploymentRuntime` is marked active (aria-current),
 *    and the group description reflects the current mode label,
 *  - a store build DISABLES the Local row (native `disabled` → click is inert,
 *    setter never fires) and surfaces the disabled reason,
 *  - an Android cloud-only build HIDES the Local row entirely,
 *  - the sandbox import-direct-state flow (store + advanced + electrobun) drives
 *    the pick→migrate RPC chain with the picked path, gates re-entry behind the
 *    busy/disabled button (double-click fires migrate exactly once), and
 *    surfaces the canceled / failed / thrown / success outcomes.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StateDirMigrationResult,
  WorkspaceFolderPickResult,
} from "../../bridge/electrobun-rpc";
import type { RuntimeModeSnapshot } from "../../api/runtime-mode-client";
import type { UseRuntimeModeState } from "../../hooks/useRuntimeMode";
import type { RuntimeDeploymentRuntime } from "../../api/runtime-mode-client";
import { ADVANCED_TOGGLE_STORAGE_KEY } from "./AdvancedToggle.hooks";

// ── stable collaborators (hoisted so vi.mock factories can close over them) ──

// Stable t() — descriptors/JSX must never mint a fresh function across renders
// (it lands in useMemo/useEffect deps inside the section).
const t = (
  key: string,
  options?: { defaultValue?: string; [k: string]: unknown },
) => {
  const raw = options?.defaultValue ?? key;
  // Interpolate the {{mode}} / {{error}} tokens the section relies on.
  return raw.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
    options && name in options ? String(options[name]) : `{{${name}}}`,
  );
};

const appMock = vi.hoisted(() => ({ value: {} as { t: typeof t } }));

const runtimeModeMock = vi.hoisted(() => ({
  state: { phase: "loading" } as UseRuntimeModeState,
}));

const mocks = vi.hoisted(() => ({
  reloadIntoFirstRunRuntime: vi.fn(),
  isStoreBuild: vi.fn(() => false),
  isAndroidCloudBuild: vi.fn(() => false),
  isElectrobunRuntime: vi.fn(() => false),
  inspectExistingElizaInstall: vi.fn(),
  pickDesktopWorkspaceFolder: vi.fn(),
  migrateDesktopStateDir: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../hooks/useRuntimeMode", () => ({
  useRuntimeMode: () => ({ state: runtimeModeMock.state }),
}));

vi.mock("../../first-run/reload-into-first-run-runtime", () => ({
  reloadIntoFirstRunRuntime: mocks.reloadIntoFirstRunRuntime,
}));

vi.mock("../../build-variant", () => ({
  isStoreBuild: () => mocks.isStoreBuild(),
}));

vi.mock("../../platform/android-runtime", () => ({
  isAndroidCloudBuild: () => mocks.isAndroidCloudBuild(),
}));

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => mocks.isElectrobunRuntime(),
}));

vi.mock("../../bridge/electrobun-rpc", () => ({
  inspectExistingElizaInstall: mocks.inspectExistingElizaInstall,
  pickDesktopWorkspaceFolder: mocks.pickDesktopWorkspaceFolder,
  migrateDesktopStateDir: mocks.migrateDesktopStateDir,
}));

import { RuntimeSettingsSection } from "./RuntimeSettingsSection";

// ── helpers ──────────────────────────────────────────────────────────────

function snapshot(
  deploymentRuntime: RuntimeDeploymentRuntime,
): RuntimeModeSnapshot {
  return {
    mode: deploymentRuntime === "local" ? "local" : deploymentRuntime,
    deploymentRuntime,
    isRemoteController: false,
    remoteApiBaseConfigured: false,
  };
}

function ready(deploymentRuntime: RuntimeDeploymentRuntime): void {
  runtimeModeMock.state = {
    phase: "ready",
    snapshot: snapshot(deploymentRuntime),
  };
}

const q = (root: HTMLElement, agentId: string) =>
  root.querySelector<HTMLButtonElement>(`[data-agent-id="${agentId}"]`);

const pickResult = (
  overrides: Partial<WorkspaceFolderPickResult> = {},
): WorkspaceFolderPickResult => ({
  canceled: false,
  path: "/Users/me/eliza-direct",
  bookmark: null,
  ...overrides,
});

const migrationResult = (
  overrides: Partial<StateDirMigrationResult> = {},
): StateDirMigrationResult => ({
  ok: true,
  migrated: true,
  fromPath: "/Users/me/eliza-direct",
  toPath: "/sandbox/state",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  appMock.value = { t };
  runtimeModeMock.state = { phase: "loading" };
  mocks.isStoreBuild.mockReturnValue(false);
  mocks.isAndroidCloudBuild.mockReturnValue(false);
  mocks.isElectrobunRuntime.mockReturnValue(false);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────

describe("RuntimeSettingsSection — mode picker (apply setter)", () => {
  it("renders the three modes and marks the deploymentRuntime row active", () => {
    ready("cloud");
    const { container } = render(<RuntimeSettingsSection />);

    const cloud = q(container, "runtime-mode-cloud");
    const local = q(container, "runtime-mode-local");
    const remote = q(container, "runtime-mode-remote");
    expect(cloud).not.toBeNull();
    expect(local).not.toBeNull();
    expect(remote).not.toBeNull();

    // aria-current is the "active" affordance; only the cloud row carries it.
    expect(cloud?.getAttribute("aria-current")).toBe("true");
    expect(local?.getAttribute("aria-current")).toBeNull();
    expect(remote?.getAttribute("aria-current")).toBeNull();
  });

  it("moves the active marker when deploymentRuntime is remote", () => {
    ready("remote");
    const { container } = render(<RuntimeSettingsSection />);
    expect(q(container, "runtime-mode-remote")?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(q(container, "runtime-mode-cloud")?.getAttribute("aria-current")).toBeNull();
  });

  it("clicking a mode fires reloadIntoFirstRunRuntime with the EXACT target", () => {
    ready("cloud");
    const { container } = render(<RuntimeSettingsSection />);

    q(container, "runtime-mode-remote")?.click();
    expect(mocks.reloadIntoFirstRunRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.reloadIntoFirstRunRuntime).toHaveBeenCalledWith("remote");

    q(container, "runtime-mode-local")?.click();
    expect(mocks.reloadIntoFirstRunRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.reloadIntoFirstRunRuntime).toHaveBeenLastCalledWith("local");

    q(container, "runtime-mode-cloud")?.click();
    expect(mocks.reloadIntoFirstRunRuntime).toHaveBeenLastCalledWith("cloud");
  });

  it("falls back to a heuristic (remote) label + no active row while the snapshot is loading", () => {
    // phase stays "loading" → currentRuntime falls back to the local heuristic,
    // which with no persisted server resolves to remote.
    const { container } = render(<RuntimeSettingsSection />);
    expect(q(container, "runtime-mode-remote")?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(container.textContent).toContain("Current mode: Remote agent");
  });
});

describe("RuntimeSettingsSection — build-variant gating", () => {
  it("store build DISABLES Local: the native disabled button never fires the setter", () => {
    mocks.isStoreBuild.mockReturnValue(true);
    ready("cloud");
    const { container } = render(<RuntimeSettingsSection />);

    const local = q(container, "runtime-mode-local");
    expect(local).not.toBeNull();
    expect(local?.disabled).toBe(true);
    // The disabled reason is surfaced as the row description.
    expect(container.textContent).toContain(
      "Local agent requires the direct download build",
    );

    // A real user click on a disabled button is inert.
    local?.click();
    expect(mocks.reloadIntoFirstRunRuntime).not.toHaveBeenCalled();

    // Cloud + Remote stay enabled and functional.
    q(container, "runtime-mode-cloud")?.click();
    expect(mocks.reloadIntoFirstRunRuntime).toHaveBeenCalledWith("cloud");
  });

  it("android cloud-only build HIDES the Local row entirely", () => {
    mocks.isAndroidCloudBuild.mockReturnValue(true);
    ready("cloud");
    const { container } = render(<RuntimeSettingsSection />);

    expect(q(container, "runtime-mode-local")).toBeNull();
    expect(q(container, "runtime-mode-cloud")).not.toBeNull();
    expect(q(container, "runtime-mode-remote")).not.toBeNull();
  });

  it("does not render the sandbox import group on a non-store build", () => {
    mocks.isStoreBuild.mockReturnValue(false);
    mocks.isElectrobunRuntime.mockReturnValue(true);
    window.localStorage.setItem(ADVANCED_TOGGLE_STORAGE_KEY, "1");
    ready("cloud");
    const { container } = render(<RuntimeSettingsSection />);
    expect(q(container, "runtime-import-direct-state")).toBeNull();
  });
});

describe("RuntimeSettingsSection — sandbox import-direct-state flow", () => {
  // Store build + advanced enabled + electrobun runtime → the import row shows.
  function primeImportSurface(): void {
    mocks.isStoreBuild.mockReturnValue(true);
    mocks.isElectrobunRuntime.mockReturnValue(true);
    window.localStorage.setItem(ADVANCED_TOGGLE_STORAGE_KEY, "1");
    ready("cloud");
  }

  it("is hidden until the advanced toggle is enabled", () => {
    mocks.isStoreBuild.mockReturnValue(true);
    mocks.isElectrobunRuntime.mockReturnValue(true);
    // advanced flag NOT set
    ready("cloud");
    const { container } = render(<RuntimeSettingsSection />);
    expect(q(container, "runtime-import-direct-state")).toBeNull();
  });

  it("happy path: picks a folder then migrates it and shows the done message", async () => {
    primeImportSurface();
    mocks.inspectExistingElizaInstall.mockResolvedValue({
      stateDir: "/existing/state",
    });
    mocks.pickDesktopWorkspaceFolder.mockResolvedValue(pickResult());
    mocks.migrateDesktopStateDir.mockResolvedValue(migrationResult());

    const { container } = render(<RuntimeSettingsSection />);
    const btn = q(container, "runtime-import-direct-state");
    expect(btn).not.toBeNull();
    btn?.click();

    await waitFor(() =>
      expect(mocks.migrateDesktopStateDir).toHaveBeenCalledTimes(1),
    );
    // The picker is seeded with the existing install's stateDir.
    expect(mocks.pickDesktopWorkspaceFolder).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "/existing/state" }),
    );
    // Migrate is driven with the PICKED path, not the default.
    expect(mocks.migrateDesktopStateDir).toHaveBeenCalledWith(
      "/Users/me/eliza-direct",
    );
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Imported direct-build data into this sandboxed build",
      ),
    );
    // Button returns to its idle label.
    await waitFor(() =>
      expect(q(container, "runtime-import-direct-state")?.disabled).toBe(false),
    );
  });

  it("busy gate: while a migrate is in-flight the button is disabled and a second click does NOT fire a second migrate", async () => {
    primeImportSurface();
    mocks.inspectExistingElizaInstall.mockResolvedValue(null);
    mocks.pickDesktopWorkspaceFolder.mockResolvedValue(pickResult());
    let resolveMigrate!: (r: StateDirMigrationResult) => void;
    mocks.migrateDesktopStateDir.mockReturnValue(
      new Promise<StateDirMigrationResult>((res) => {
        resolveMigrate = res;
      }),
    );

    const { container } = render(<RuntimeSettingsSection />);
    q(container, "runtime-import-direct-state")?.click();

    // Once the async handler reaches the pending migrate, the button is busy.
    await waitFor(() => {
      const b = q(container, "runtime-import-direct-state");
      expect(b?.disabled).toBe(true);
      expect(b?.textContent).toContain("Importing");
    });
    expect(mocks.migrateDesktopStateDir).toHaveBeenCalledTimes(1);

    // Second click on the now-disabled button is inert.
    q(container, "runtime-import-direct-state")?.click();
    await Promise.resolve();
    expect(mocks.migrateDesktopStateDir).toHaveBeenCalledTimes(1);

    // Resolve → success message, button re-enabled.
    resolveMigrate(migrationResult());
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Imported direct-build data into this sandboxed build",
      ),
    );
  });

  it("canceled pick shows the canceled message and NEVER calls migrate", async () => {
    primeImportSurface();
    mocks.inspectExistingElizaInstall.mockResolvedValue(null);
    mocks.pickDesktopWorkspaceFolder.mockResolvedValue(
      pickResult({ canceled: true, path: "" }),
    );

    const { container } = render(<RuntimeSettingsSection />);
    q(container, "runtime-import-direct-state")?.click();

    await waitFor(() =>
      expect(container.textContent).toContain("Import canceled."),
    );
    expect(mocks.migrateDesktopStateDir).not.toHaveBeenCalled();
  });

  it("migrate returning ok:false surfaces the interpolated failure reason", async () => {
    primeImportSurface();
    mocks.inspectExistingElizaInstall.mockResolvedValue(null);
    mocks.pickDesktopWorkspaceFolder.mockResolvedValue(pickResult());
    mocks.migrateDesktopStateDir.mockResolvedValue(
      migrationResult({ ok: false, migrated: false, error: "disk full" }),
    );

    const { container } = render(<RuntimeSettingsSection />);
    q(container, "runtime-import-direct-state")?.click();

    await waitFor(() =>
      expect(container.textContent).toContain("Import failed: disk full"),
    );
  });

  it("migrate returning migrated:false shows the nothing-imported message", async () => {
    primeImportSurface();
    mocks.inspectExistingElizaInstall.mockResolvedValue(null);
    mocks.pickDesktopWorkspaceFolder.mockResolvedValue(pickResult());
    mocks.migrateDesktopStateDir.mockResolvedValue(
      migrationResult({ ok: true, migrated: false }),
    );

    const { container } = render(<RuntimeSettingsSection />);
    q(container, "runtime-import-direct-state")?.click();

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Nothing was imported from that folder.",
      ),
    );
  });

  it("a null migrate result (bridge unavailable) shows the unavailable message", async () => {
    primeImportSurface();
    mocks.inspectExistingElizaInstall.mockResolvedValue(null);
    mocks.pickDesktopWorkspaceFolder.mockResolvedValue(pickResult());
    mocks.migrateDesktopStateDir.mockResolvedValue(null);

    const { container } = render(<RuntimeSettingsSection />);
    q(container, "runtime-import-direct-state")?.click();

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Import is unavailable in this runtime.",
      ),
    );
  });

  it("a thrown bridge error is caught and surfaced with the error message, button recovers", async () => {
    primeImportSurface();
    mocks.inspectExistingElizaInstall.mockRejectedValue(
      new Error("bridge exploded"),
    );

    const { container } = render(<RuntimeSettingsSection />);
    q(container, "runtime-import-direct-state")?.click();

    await waitFor(() =>
      expect(container.textContent).toContain("Import failed: bridge exploded"),
    );
    // finally{} cleared busy → button is interactive again.
    await waitFor(() =>
      expect(q(container, "runtime-import-direct-state")?.disabled).toBe(false),
    );
    expect(mocks.migrateDesktopStateDir).not.toHaveBeenCalled();
  });

  it("non-electrobun store build shows the unavailable note instead of the import button", () => {
    mocks.isStoreBuild.mockReturnValue(true);
    mocks.isElectrobunRuntime.mockReturnValue(false);
    window.localStorage.setItem(ADVANCED_TOGGLE_STORAGE_KEY, "1");
    ready("cloud");
    const { container } = render(<RuntimeSettingsSection />);

    expect(q(container, "runtime-import-direct-state")).toBeNull();
    expect(container.textContent).toContain(
      "Local agent is unavailable in this build.",
    );
  });
});
