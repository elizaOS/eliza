// @vitest-environment jsdom

/**
 * Behavioral coverage for Settings → Apps management (AppsManagementSection).
 *
 * The sibling *.stories.tsx only renders states for the visual audit; nothing
 * exercises the action → API-call → notice pipeline. This file drives the real
 * per-row actions (Launch / Relaunch / Edit / Stop) and asserts the EXACT
 * transport call + payload against the mocked `client` boundary, plus the
 * loading / empty / error list states, the in-flight (busy) idempotency gate,
 * and that the create form refuses to submit blank intent.
 *
 * NOTE on scope: the driving prompt assumed an enable/disable + install/
 * uninstall (+ confirm gate) + reorder surface. This component has none of
 * those — its real surface is Launch / Relaunch / Edit / Stop / Create / Load.
 * Stop is the only destructive-ish action and is gated purely by "is this app
 * running" + a per-app busy latch; there is NO window.confirm dialog. Tests
 * below cover the surface that actually exists.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppRunSummary,
  AppStopResult,
  InstalledAppInfo,
} from "../../api/client-types-cloud";
import { ADVANCED_TOGGLE_STORAGE_KEY } from "./AdvancedToggle.hooks";

// ── mocked collaborators ─────────────────────────────────────────────────────

// Stable t() so descriptors/JSX never mint fresh functions across renders.
const t = (
  key: string,
  options?: { defaultValue?: string; [k: string]: unknown },
) => options?.defaultValue ?? key;

const appMock = vi.hoisted(() => ({
  value: {} as {
    setActionNotice: ReturnType<typeof vi.fn>;
    t: typeof t;
  },
}));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
}));

const clientMock = vi.hoisted(() => ({
  listInstalledApps: vi.fn(),
  listAppRuns: vi.fn(),
  launchApp: vi.fn(),
  stopApp: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

import { AppsManagementSection } from "./AppsManagementSection";

// ── fixtures ─────────────────────────────────────────────────────────────────

function app(overrides: Partial<InstalledAppInfo> = {}): InstalledAppInfo {
  return {
    name: "todo-app",
    displayName: "Todo App",
    version: "1.2.3",
    installPath: "/apps/todo-app",
    installedAt: "2026-01-01T00:00:00.000Z",
    isRunning: false,
    ...overrides,
  };
}

// The component only reads run.appName + appRuns.length, so a minimal shape
// (typed through the real interface) is faithful to what it consumes.
function run(appName: string): AppRunSummary {
  return { appName } as AppRunSummary;
}

const STOP_RESULT: AppStopResult = {
  success: true,
  appName: "todo-app",
  runId: "run-1",
  stoppedAt: "2026-01-01T00:00:00.000Z",
  pluginUninstalled: false,
  needsRestart: false,
  stopScope: "viewer-session",
  message: "Todo App stopped.",
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function btn(label: string): HTMLButtonElement {
  const el = document.querySelector(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no button with aria-label="${label}"`);
  return el as HTMLButtonElement;
}

function btnByText(text: string): HTMLButtonElement {
  const el = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!el) throw new Error(`no button with text="${text}"`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  appMock.value = { setActionNotice: vi.fn(), t };
  clientMock.listInstalledApps.mockReset().mockResolvedValue([]);
  clientMock.listAppRuns.mockReset().mockResolvedValue([]);
  clientMock.launchApp.mockReset().mockResolvedValue({ ok: true });
  clientMock.stopApp.mockReset().mockResolvedValue(STOP_RESULT);
  clientMock.fetch.mockReset().mockResolvedValue({ ok: true, message: "done" });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppsManagementSection — list states", () => {
  it("shows the loading placeholder before the app list resolves", () => {
    // Never-resolving list so we observe the initial loading state.
    clientMock.listInstalledApps.mockReturnValue(new Promise(() => {}));
    clientMock.listAppRuns.mockReturnValue(new Promise(() => {}));
    const { container } = render(<AppsManagementSection />);
    expect(container.textContent).toContain("Loading apps…");
  });

  it("renders the empty state when no apps are installed", async () => {
    const { container } = render(<AppsManagementSection />);
    await flush();
    expect(container.textContent).toContain("No apps installed yet.");
    expect(clientMock.listInstalledApps).toHaveBeenCalledTimes(1);
    expect(clientMock.listAppRuns).toHaveBeenCalledTimes(1);
  });

  it("surfaces the error message when loading the app list rejects", async () => {
    clientMock.listInstalledApps.mockRejectedValue(new Error("boom fetching"));
    const { container } = render(<AppsManagementSection />);
    await flush();
    expect(container.textContent).toContain("boom fetching");
    expect(container.textContent).not.toContain("No apps installed yet.");
  });

  it("renders one row per installed app with id + version", async () => {
    clientMock.listInstalledApps.mockResolvedValue([
      app(),
      app({ name: "notes-app", displayName: "Notes", version: "" }),
    ]);
    const { container } = render(<AppsManagementSection />);
    await flush();
    expect(
      container.querySelector('[data-testid="apps-mgmt-row-todo-app"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="apps-mgmt-row-notes-app"]'),
    ).not.toBeNull();
    // version "" falls back to an em-dash placeholder.
    const notesRow = container.querySelector(
      '[data-testid="apps-mgmt-row-notes-app"]',
    ) as HTMLElement;
    expect(notesRow.textContent).toContain("—");
    expect(container.textContent).toContain("1.2.3");
  });
});

describe("AppsManagementSection — row actions fire the right call with the app id", () => {
  async function mount(runs: AppRunSummary[] = []) {
    clientMock.listInstalledApps.mockResolvedValue([app()]);
    clientMock.listAppRuns.mockResolvedValue(runs);
    const view = render(<AppsManagementSection />);
    await flush();
    return view;
  }

  it("Launch calls client.launchApp(app.name) and posts a success notice", async () => {
    await mount();
    fireEvent.click(btn("Launch Todo App"));
    await flush();
    expect(clientMock.launchApp).toHaveBeenCalledTimes(1);
    expect(clientMock.launchApp).toHaveBeenCalledWith("todo-app");
    expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
      "Todo App launched.",
      "success",
      3000,
    );
    // refresh() re-queries the list after a successful launch.
    expect(clientMock.listInstalledApps).toHaveBeenCalledTimes(2);
  });

  it("Launch failure routes the error message to an error notice, not a throw", async () => {
    await mount();
    clientMock.launchApp.mockRejectedValue(new Error("port in use"));
    fireEvent.click(btn("Launch Todo App"));
    await flush();
    expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
      "port in use",
      "error",
      5000,
    );
  });

  it("Relaunch POSTs /api/apps/relaunch with {name, verify:true} by default", async () => {
    await mount();
    fireEvent.click(btn("Relaunch Todo App"));
    await flush();
    expect(clientMock.fetch).toHaveBeenCalledTimes(1);
    const [path, opts] = clientMock.fetch.mock.calls[0];
    expect(path).toBe("/api/apps/relaunch");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "todo-app", verify: true });
  });

  it("Edit POSTs /api/apps/create with intent:edit + editTarget = app id", async () => {
    await mount();
    fireEvent.click(btn("Edit Todo App"));
    await flush();
    const [path, opts] = clientMock.fetch.mock.calls[0];
    expect(path).toBe("/api/apps/create");
    expect(JSON.parse(opts.body)).toEqual({
      intent: "edit",
      editTarget: "todo-app",
    });
    // Edit does NOT re-query the list (it hands off to the create flow).
    expect(clientMock.listInstalledApps).toHaveBeenCalledTimes(1);
  });

  it("Stop is only offered for a running app and calls client.stopApp(app.name)", async () => {
    // First: no runs → no Stop button.
    await mount([]);
    expect(
      document.querySelector('button[aria-label="Stop Todo App"]'),
    ).toBeNull();
    cleanup();

    // Now: a live run → Stop appears and dispatches with the app id.
    await mount([run("todo-app")]);
    const stop = btn("Stop Todo App");
    fireEvent.click(stop);
    await flush();
    expect(clientMock.stopApp).toHaveBeenCalledTimes(1);
    expect(clientMock.stopApp).toHaveBeenCalledWith("todo-app");
    expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
      "Todo App stopped.",
      "success",
      3500,
    );
  });
});

describe("AppsManagementSection — in-flight idempotency gate", () => {
  it("disables the row while an action is in flight so a second click is a no-op", async () => {
    clientMock.listInstalledApps.mockResolvedValue([app()]);
    clientMock.listAppRuns.mockResolvedValue([]);
    const gate = deferred<{ ok: boolean }>();
    clientMock.launchApp.mockReturnValue(gate.promise);

    render(<AppsManagementSection />);
    await flush();

    const launch = btn("Launch Todo App");
    fireEvent.click(launch);
    await flush(); // let busyApp commit → row buttons disable

    expect(clientMock.launchApp).toHaveBeenCalledTimes(1);
    // The whole row is latched busy while the launch is pending.
    expect(btn("Launch Todo App").disabled).toBe(true);
    expect(btn("Relaunch Todo App").disabled).toBe(true);
    expect(btn("Edit Todo App").disabled).toBe(true);

    // A second click on the (disabled) button must not fire another call.
    fireEvent.click(btn("Launch Todo App"));
    fireEvent.click(btn("Relaunch Todo App"));
    await flush();
    expect(clientMock.launchApp).toHaveBeenCalledTimes(1);
    expect(clientMock.fetch).not.toHaveBeenCalled();

    // Resolving the launch clears the busy latch and re-enables the row.
    gate.resolve({ ok: true });
    await flush();
    await flush();
    expect(btn("Launch Todo App").disabled).toBe(false);
  });
});

describe("AppsManagementSection — create form validation", () => {
  it("refuses to submit a blank / whitespace-only intent (no transport call)", async () => {
    render(<AppsManagementSection />);
    await flush();

    // Open the create panel.
    fireEvent.click(btnByText("Create new app"));
    const textarea = document.getElementById(
      "apps-create-intent",
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    // Whitespace-only intent — the guard must reject it.
    fireEvent.change(textarea, { target: { value: "   " } });
    const form = textarea.closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    await flush();
    expect(clientMock.fetch).not.toHaveBeenCalled();

    // A real intent submits exactly once with the trimmed payload.
    fireEvent.change(textarea, { target: { value: "  build a timer  " } });
    fireEvent.submit(form);
    await flush();
    expect(clientMock.fetch).toHaveBeenCalledTimes(1);
    const [path, opts] = clientMock.fetch.mock.calls[0];
    expect(path).toBe("/api/apps/create");
    expect(JSON.parse(opts.body)).toEqual({ intent: "build a timer" });
  });
});

describe("AppsManagementSection — advanced relaunch verify toggle", () => {
  it("sends verify:false when 'Verify on relaunch' is unchecked", async () => {
    // Advanced settings on → the verify checkbox is rendered.
    window.localStorage.setItem(ADVANCED_TOGGLE_STORAGE_KEY, "1");
    clientMock.listInstalledApps.mockResolvedValue([app()]);
    clientMock.listAppRuns.mockResolvedValue([]);
    render(<AppsManagementSection />);
    await flush();

    const verify = document.querySelector(
      'button[aria-label="Verify on relaunch"][role="checkbox"]',
    ) as HTMLButtonElement | null;
    // Default is checked (verify on). Uncheck it.
    expect(verify).not.toBeNull();
    fireEvent.click(verify as HTMLButtonElement);
    await flush();

    fireEvent.click(btn("Relaunch Todo App"));
    await flush();
    const [, opts] = clientMock.fetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ name: "todo-app", verify: false });
  });
});
