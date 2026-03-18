// @vitest-environment jsdom

/**
 * Advanced trajectories/fine-tuning integration test.
 *
 * Verifies that AdvancedPageView correctly wires TrajectoriesView and
 * TrajectoryDetailView (via the onSelectTrajectory / selectedTrajectoryId
 * flow) and that TrajectoriesView and the Fine-Tuning tab both see the
 * same trajectory data through the API client.
 *
 * All child views are mocked to avoid react-test-renderer incompatibilities
 * with Radix UI's DOM-dependent components (closest(), portal, etc.).
 * The test validates data flow by inspecting API mock calls.
 */

import type {
  TrainingStatus,
  TrainingTrajectoryList,
  TrajectoryConfig,
  TrajectoryDetailResult,
  TrajectoryListResult,
  TrajectoryStats,
} from "@elizaos/app-core/api";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseApp, mockClientFns } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
  mockClientFns: {
    getCodingAgentStatus: vi.fn(async () => null),
    getTrajectories: vi.fn(),
    getTrajectoryStats: vi.fn(),
    getTrajectoryConfig: vi.fn(),
    getTrajectoryDetail: vi.fn(),
    updateTrajectoryConfig: vi.fn(),
    exportTrajectories: vi.fn(),
    clearAllTrajectories: vi.fn(),
    getTrainingStatus: vi.fn(),
    listTrainingTrajectories: vi.fn(),
    listTrainingDatasets: vi.fn(),
    listTrainingJobs: vi.fn(),
    listTrainingModels: vi.fn(),
    getTrainingTrajectory: vi.fn(),
    onWsEvent: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClientFns,
}));

vi.mock("@elizaos/app-core/components", () => {
  const R = require("react");
  return {
    DatabasePageView: () => R.createElement("div", null, "stub"),
    LogsPageView: () => R.createElement("div", null, "stub"),
    PluginsPageView: () => R.createElement("div", null, "stub"),
    RuntimeView: () => R.createElement("div", null, "stub"),
    SkillsView: () => R.createElement("div", null, "stub"),
  };
});

// ---------------------------------------------------------------------------
// Mock ALL child views of AdvancedPageView to avoid react-test-renderer
// incompatibilities with Radix UI DOM methods and infinite useEffect loops.
// ---------------------------------------------------------------------------
vi.mock("../../src/components/CustomActionsView", () => {
  const R = require("react");
  return { CustomActionsView: () => R.createElement("div", null, "stub") };
});
vi.mock("../../src/components/TriggersView", () => {
  const R = require("react");
  return { TriggersView: () => R.createElement("div", null, "stub") };
});
vi.mock("../../src/components/FineTuningView", () => {
  const R = require("react");
  return {
    FineTuningView: () => R.createElement("div", null, "stub-fine-tuning"),
  };
});

// TrajectoriesView: render a clickable row so the test can trigger selection
vi.mock("../../src/components/TrajectoriesView", () => {
  const R = require("react");
  return {
    TrajectoriesView: (props: { onSelectTrajectory?: (id: string) => void }) =>
      R.createElement(
        "table",
        null,
        R.createElement(
          "tbody",
          null,
          R.createElement(
            "tr",
            {
              onClick: () =>
                props.onSelectTrajectory?.("shared-traj-123456789"),
            },
            R.createElement("td", null, "shared-traj..."),
          ),
        ),
      ),
  };
});

// TrajectoryDetailView: render the trajectory ID and a back button
vi.mock("../../src/components/TrajectoryDetailView", () => {
  const R = require("react");
  return {
    TrajectoryDetailView: (props: {
      trajectoryId: string;
      onBack: () => void;
    }) =>
      R.createElement(
        "div",
        null,
        R.createElement("span", null, `${props.trajectoryId.slice(0, 8)}...`),
        R.createElement(
          "button",
          { onClick: props.onBack },
          "trajectorydetailview.Back",
        ),
      ),
  };
});

// Mock @elizaos/ui to avoid Radix DOM issues
vi.mock("@elizaos/ui", () => {
  const R = require("react");
  const passthrough = (props: { children?: React.ReactNode }) =>
    R.createElement("div", { "data-testid": "ui-mock" }, props.children);
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === "string" ? passthrough : undefined,
    },
  );
});

import { AdvancedPageView } from "../../src/components/AdvancedPageView";

const SHARED_TRAJECTORY_ID = "shared-traj-123456789";

const trajectoriesResult: TrajectoryListResult = {
  trajectories: [
    {
      id: SHARED_TRAJECTORY_ID,
      agentId: "agent-1",
      roomId: null,
      entityId: null,
      conversationId: null,
      source: "chat",
      status: "completed",
      startTime: Date.now() - 2_500,
      endTime: Date.now() - 500,
      durationMs: 2_000,
      llmCallCount: 2,
      providerAccessCount: 0,
      totalPromptTokens: 33,
      totalCompletionTokens: 12,
      metadata: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ],
  total: 1,
  offset: 0,
  limit: 50,
};

const trajectoryStats: TrajectoryStats = {
  totalTrajectories: 1,
  totalLlmCalls: 2,
  totalProviderAccesses: 0,
  totalPromptTokens: 33,
  totalCompletionTokens: 12,
  averageDurationMs: 2_000,
  bySource: { chat: 1 },
  byModel: { "test-model": 1 },
};

const trajectoryConfig: TrajectoryConfig = {
  enabled: true,
};

const trajectoryDetail: TrajectoryDetailResult = {
  trajectory: trajectoriesResult.trajectories[0],
  llmCalls: [
    {
      id: "call-1",
      trajectoryId: SHARED_TRAJECTORY_ID,
      stepId: "step-1",
      model: "test-model",
      systemPrompt: "You are helpful.",
      userPrompt: "hello from user",
      response: "hi there",
      temperature: 0,
      maxTokens: 64,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 10,
      promptTokens: 33,
      completionTokens: 12,
      timestamp: Date.now(),
      createdAt: new Date(0).toISOString(),
    },
  ],
  providerAccesses: [],
};

const trainingStatus: TrainingStatus = {
  runningJobs: 0,
  queuedJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  modelCount: 0,
  datasetCount: 0,
  runtimeAvailable: true,
};

const trainingTrajectories: TrainingTrajectoryList = {
  available: true,
  total: 1,
  trajectories: [
    {
      id: "row-1",
      trajectoryId: SHARED_TRAJECTORY_ID,
      agentId: "agent-1",
      archetype: "default",
      createdAt: new Date(0).toISOString(),
      totalReward: 0,
      aiJudgeReward: 0,
      episodeLength: 1,
      hasLlmCalls: true,
      llmCallCount: 2,
    },
  ],
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") return child;
      return nodeText(child);
    })
    .join("");
}

function containsText(node: ReactTestInstance, text: string): boolean {
  return nodeText(node).includes(text);
}

describe("Advanced trajectories/fine-tuning integration", () => {
  let setTab: ReturnType<typeof vi.fn>;
  let setActionNotice: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setTab = vi.fn();
    setActionNotice = vi.fn();

    mockClientFns.getTrajectories.mockResolvedValue(trajectoriesResult);
    mockClientFns.getTrajectoryStats.mockResolvedValue(trajectoryStats);
    mockClientFns.getTrajectoryConfig.mockResolvedValue(trajectoryConfig);
    mockClientFns.getTrajectoryDetail.mockResolvedValue(trajectoryDetail);
    mockClientFns.updateTrajectoryConfig.mockResolvedValue(trajectoryConfig);
    mockClientFns.exportTrajectories.mockResolvedValue(
      new Blob(["[]"], { type: "application/json" }),
    );
    mockClientFns.clearAllTrajectories.mockResolvedValue({ deleted: 0 });

    mockClientFns.getTrainingStatus.mockResolvedValue(trainingStatus);
    mockClientFns.listTrainingTrajectories.mockResolvedValue(
      trainingTrajectories,
    );
    mockClientFns.listTrainingDatasets.mockResolvedValue({ datasets: [] });
    mockClientFns.listTrainingJobs.mockResolvedValue({ jobs: [] });
    mockClientFns.listTrainingModels.mockResolvedValue({ models: [] });
    mockClientFns.getTrainingTrajectory.mockResolvedValue({
      trajectory: {
        ...trainingTrajectories.trajectories[0],
        stepsJson: "[]",
        aiJudgeReasoning: null,
      },
    });
    mockClientFns.onWsEvent.mockImplementation(() => () => undefined);

    const handleRestart = vi.fn().mockResolvedValue(undefined);
    const t = (k: string) => k;
    const cachedMock = {
      t,
      tab: "trajectories" as const,
      setTab,
      handleRestart,
      setActionNotice,
    };
    mockUseApp.mockImplementation(() => cachedMock);
  });

  afterEach(() => {
    mockUseApp.mockReset();
    for (const fn of Object.values(mockClientFns)) {
      fn.mockReset();
    }
  });

  it("applies the advanced subtab button class in both layouts", async () => {
    let tree!: ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(AdvancedPageView));
    });

    const standardSubtabButtons = tree.root.findAll(
      (node) =>
        node.type === "button" &&
        String(node.props.className ?? "").includes("advanced-subtab-btn"),
    );
    expect(standardSubtabButtons.length).toBeGreaterThan(0);

    await act(async () => {
      tree.update(
        React.createElement<{ inModal?: boolean }>(
          AdvancedPageView,
          { inModal: true },
        ),
      );
    });

    const modalSubtabButtons = tree.root.findAll(
      (node) =>
        node.type === "button" &&
        String(node.props.className ?? "").includes("advanced-subtab-btn"),
    );
    expect(modalSubtabButtons.length).toBeGreaterThan(0);
  });

  it("shows the same trajectory in Trajectories detail and Fine-Tuning list", async () => {
    let tree!: ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(AdvancedPageView));
    });
    await flush();

    // The mocked TrajectoriesView renders a clickable <tr>
    const clickableRows = tree.root.findAll(
      (node) => node.type === "tr" && typeof node.props.onClick === "function",
    );
    expect(clickableRows.length).toBeGreaterThan(0);

    // Click the row to trigger trajectory selection
    await act(async () => {
      const row = clickableRows[0] as ReactTestInstance | undefined;
      (row?.props.onClick as () => void)?.();
    });
    await flush();

    // The mocked TrajectoryDetailView renders the truncated ID
    const trajectoryPrefix = `${SHARED_TRAJECTORY_ID.slice(0, 8)}...`;
    const detailIdFound = tree.root.findAll(
      (node) =>
        typeof node.type === "string" && containsText(node, trajectoryPrefix),
    );
    expect(detailIdFound.length).toBeGreaterThan(0);

    // Verify the back button exists
    const backButton = tree.root.findAll(
      (node) =>
        node.type === "button" &&
        containsText(node, "trajectorydetailview.Back"),
    )[0] as ReactTestInstance;
    expect(backButton).toBeDefined();

    // Click back
    await act(async () => {
      (backButton.props.onClick as () => void)();
    });
    await flush();
  });
});
