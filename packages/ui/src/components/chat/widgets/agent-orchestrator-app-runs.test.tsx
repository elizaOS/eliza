// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBaseUrlMock,
  listAppRunsMock,
  loadMergedCatalogAppsMock,
  mockState,
} = vi.hoisted(() => ({
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

beforeEach(() => {
  getBaseUrlMock.mockReset();
  getBaseUrlMock.mockReturnValue("http://localhost");
  listAppRunsMock.mockClear();
  loadMergedCatalogAppsMock.mockClear();
  mockState.setTab.mockClear();
  mockState.setState.mockClear();
});

afterEach(() => {
  cleanup();
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
});
