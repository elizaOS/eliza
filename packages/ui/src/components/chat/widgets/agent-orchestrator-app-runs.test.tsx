// @vitest-environment jsdom
//
// AppRunsWidget polling gates: skips the app-run poll on limited cloud agent
// bases and while unauthenticated, starts once the session authenticates, and
// (the #14346 gate) pauses the recurring poll while the tab is backgrounded and
// resumes it on foreground. jsdom render with the API client + auth hook + app
// store mocked (no backend); document.visibilityState is driven directly.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  authMock,
  getBaseUrlMock,
  listAppRunsMock,
  loadMergedCatalogAppsMock,
  mockState,
} = vi.hoisted(() => ({
  // Auth gate (#11084) — mutable so tests can flip the session state.
  authMock: { authenticated: true },
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  listAppRunsMock: vi.fn(async () => []),
  loadMergedCatalogAppsMock: vi.fn(async () => []),
  mockState: {
    appRuns: [],
    setTab: vi.fn(),
    setState: vi.fn(),
    t: (_key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? "",
  },
}));

vi.mock("../../../api", () => ({
  client: {
    getBaseUrl: getBaseUrlMock,
    listAppRuns: listAppRunsMock,
  },
}));

vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

vi.mock("../../../state", () => ({
  useAppSelectorShallow: <T,>(selector: (state: typeof mockState) => T): T =>
    selector(mockState),
}));

vi.mock("../../apps/catalog-loader", () => ({
  loadMergedCatalogApps: loadMergedCatalogAppsMock,
}));

import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "./agent-orchestrator";

const AppRunsWidget = AGENT_ORCHESTRATOR_PLUGIN_WIDGETS.find(
  (widget) => widget.id === "agent-orchestrator.apps",
)?.Component;

if (!AppRunsWidget) {
  throw new Error("agent-orchestrator.apps widget not registered");
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  getBaseUrlMock.mockReset();
  getBaseUrlMock.mockReturnValue("http://localhost");
  listAppRunsMock.mockClear();
  loadMergedCatalogAppsMock.mockClear();
  mockState.setTab.mockClear();
  mockState.setState.mockClear();
  authMock.authenticated = true;
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
});

describe("AppRunsWidget", () => {
  it("skips app-run polling on limited cloud agent bases", async () => {
    getBaseUrlMock.mockReturnValue("https://agent-1.elizacloud.ai");

    const { container } = render(
      <AppRunsWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(listAppRunsMock).not.toHaveBeenCalled();
    expect(mockState.setState).toHaveBeenCalledWith("appRuns", []);
  });

  // #11084 — the widget mounts before the auth probe resolves; the 5s run
  // poll must not fire a single request while the session is unauthenticated.
  it("does not poll app runs while unauthenticated", async () => {
    authMock.authenticated = false;

    const { container } = render(
      <AppRunsWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(listAppRunsMock).not.toHaveBeenCalled();
    expect(mockState.setState).toHaveBeenCalledWith("appRuns", []);
  });

  it("polls app runs once the session is authenticated", async () => {
    render(
      <AppRunsWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(listAppRunsMock).toHaveBeenCalled();
    });
  });

  // #14346 — a backgrounded webview must stop waking the API. The recurring
  // poll is gated on document visibility; the immediate first fetch still fires
  // once on mount (that gate governs the interval, not the initial load).
  it("does not poll while the document is hidden and resumes on foreground", async () => {
    vi.useFakeTimers();

    render(
      <AppRunsWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );
    // Flush the mount effect's immediate fetch.
    await act(async () => {});
    expect(listAppRunsMock).toHaveBeenCalledTimes(1);

    // Background the tab: advancing well past several 15s ticks yields no
    // further requests — the interval is unsubscribed while hidden.
    act(() => setVisibility("hidden"));
    await act(async () => {
      vi.advanceTimersByTime(15_000 * 3);
    });
    expect(listAppRunsMock).toHaveBeenCalledTimes(1);

    // Foreground again: the poll resumes on the next tick.
    act(() => setVisibility("visible"));
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(listAppRunsMock).toHaveBeenCalledTimes(2);
  });
});
