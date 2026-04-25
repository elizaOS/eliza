// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryAppInfo } from "../../../api";
import type { AppRunSummary } from "../../../api/client-types-cloud";

const { useAppMock, clientMock } = vi.hoisted(() => ({
  useAppMock: vi.fn(),
  clientMock: {
    listApps: vi.fn(),
    listAppRuns: vi.fn(),
    listCatalogApps: vi.fn(),
  },
}));

vi.mock("../../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../../api", () => ({
  client: clientMock,
}));

import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "./agent-orchestrator";

function makeCatalogCandidate(
  name: string,
  category: RegistryAppInfo["category"] = "utility",
): RegistryAppInfo {
  return {
    name,
    displayName: name,
    description: "",
    category,
    launchType: "local",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

function buildRun(overrides?: Partial<AppRunSummary>): AppRunSummary {
  return {
    runId: "run-1",
    appName: "@elizaos/app-companion",
    displayName: "Milady Companion",
    pluginName: "@elizaos/plugin-apps",
    launchType: "local",
    launchUrl: null,
    viewer: null,
    session: null,
    characterId: null,
    agentId: null,
    status: "running",
    summary: "Ready for chat.",
    startedAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:01:00.000Z",
    lastHeartbeatAt: "2026-04-23T12:01:00.000Z",
    supportsBackground: true,
    supportsViewerDetach: false,
    chatAvailability: "available",
    controlAvailability: "available",
    viewerAttachment: "detached",
    recentEvents: [],
    awaySummary: null,
    health: {
      state: "healthy",
      message: "Healthy",
    },
    ...overrides,
  };
}

function buildUseAppState(overrides?: Record<string, unknown>) {
  return {
    appRuns: [],
    setTab: vi.fn(),
    setState: vi.fn(),
    t: (key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? key,
    ...overrides,
  };
}

describe("agent orchestrator app runs widget", () => {
  beforeEach(() => {
    useAppMock.mockReset();
    clientMock.listApps.mockReset();
    clientMock.listAppRuns.mockReset();
    clientMock.listCatalogApps.mockReset();

    useAppMock.mockReturnValue(buildUseAppState());
    clientMock.listApps.mockResolvedValue([]);
    clientMock.listCatalogApps.mockResolvedValue([]);
    clientMock.listAppRuns.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders hero artwork for running apps when metadata is available", async () => {
    const AppRunsWidget = AGENT_ORCHESTRATOR_PLUGIN_WIDGETS.find(
      (widget) => widget.id === "agent-orchestrator.apps",
    )?.Component;

    expect(AppRunsWidget).toBeDefined();

    clientMock.listApps.mockResolvedValue([
      {
        ...makeCatalogCandidate("@elizaos/app-companion", "game"),
        displayName: "Milady Companion",
        icon: "/icons/companion.svg",
        heroImage: "/heroes/companion.png",
      },
    ]);
    clientMock.listAppRuns.mockResolvedValue([buildRun()]);

    const { container } = render(
      AppRunsWidget ? (
        <AppRunsWidget events={[]} clearEvents={() => undefined} />
      ) : null,
    );

    expect(
      (await screen.findAllByText("Milady Companion")).length,
    ).toBeGreaterThan(0);
    await waitFor(() => {
      expect(
        container.querySelector('img[src="/heroes/companion.png"]'),
      ).not.toBeNull();
    });
  });
});
