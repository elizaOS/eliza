// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

const trainingClient = vi.hoisted(() => ({
  getTrainingStatus: vi.fn(),
  listTrainingTrajectories: vi.fn(),
  getTrainingTrajectory: vi.fn(),
  listTrainingDatasets: vi.fn(),
  buildTrainingDataset: vi.fn(),
  listTrainingJobs: vi.fn(),
  startTrainingJob: vi.fn(),
  getTrainingJob: vi.fn(),
  cancelTrainingJob: vi.fn(),
  listTrainingModels: vi.fn(),
  importTrainingModelToOllama: vi.fn(),
  activateTrainingModel: vi.fn(),
  benchmarkTrainingModel: vi.fn(),
  onWsEvent: vi.fn(() => () => undefined),
  sendChatRest: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  ContentLayout: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  client: trainingClient,
  confirmDesktopAction: vi.fn(),
  parsePositiveFloat: (value: string) => Number.parseFloat(value),
  parsePositiveInteger: (value: string) => Number.parseInt(value, 10),
  useApp: () => ({
    handleRestart: vi.fn(),
    setActionNotice: vi.fn(),
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
  useIntervalWhenDocumentVisible: vi.fn(),
}));

vi.mock("./fine-tuning-panels.js", () => ({
  asTrainingEvent: vi.fn(),
  DatasetSection: () => React.createElement("section", {}, "datasets"),
  FINE_TUNING_ACTION_CLASS: "",
  FINE_TUNING_SECTION_CLASS: "",
  FINE_TUNING_SECTION_HEADER_CLASS: "",
  FINE_TUNING_SECTION_KICKER_CLASS: "",
  FINE_TUNING_STATUS_CARD_CLASS: "",
  LiveEventsPanel: () => React.createElement("section", {}, "events"),
  TrainedModelsSection: () => React.createElement("section", {}, "models"),
  TrainingJobsSection: () => React.createElement("section", {}, "jobs"),
  TrajectoriesSection: () => React.createElement("section", {}, "trajectories"),
}));

import { FineTuningTuiView, interact } from "./FineTuningView";

const sampleStatus = {
  runningJobs: 1,
  queuedJobs: 1,
  completedJobs: 2,
  failedJobs: 0,
  modelCount: 1,
  datasetCount: 1,
  runtimeAvailable: true,
};

const sampleTrajectories = {
  available: true,
  total: 1,
  trajectories: [
    {
      id: "summary-1",
      trajectoryId: "trajectory-1",
      agentId: "agent-1",
      archetype: "support",
      createdAt: "2026-05-18T12:00:00.000Z",
      totalReward: 0.9,
      aiJudgeReward: null,
      episodeLength: 4,
      hasLlmCalls: true,
      llmCallCount: 3,
    },
  ],
};

const sampleDataset = {
  id: "dataset-1",
  createdAt: "2026-05-18T12:00:00.000Z",
  jsonlPath: "/tmp/dataset.jsonl",
  trajectoryDir: "/tmp/trajectories",
  metadataPath: "/tmp/metadata.json",
  sampleCount: 12,
  trajectoryCount: 3,
};

const sampleJob = {
  id: "job-1",
  createdAt: "2026-05-18T12:00:00.000Z",
  startedAt: null,
  completedAt: null,
  status: "running",
  phase: "train",
  progress: 0.5,
  error: null,
  exitCode: null,
  signal: null,
  options: { backend: "cpu", datasetId: "dataset-1" },
  datasetId: "dataset-1",
  pythonRoot: "/tmp/python",
  scriptPath: "/tmp/train.py",
  outputDir: "/tmp/out",
  logPath: "/tmp/train.log",
  modelPath: null,
  adapterPath: null,
  modelId: null,
  logs: ["step 1"],
};

const sampleModel = {
  id: "model-1",
  createdAt: "2026-05-18T12:00:00.000Z",
  jobId: "job-1",
  outputDir: "/tmp/out",
  modelPath: "/tmp/model",
  adapterPath: null,
  sourceModel: "base-model",
  backend: "cpu",
  ollamaModel: "eliza-model",
  active: true,
  benchmark: { status: "passed", lastRunAt: null, output: null },
};

function mockState() {
  trainingClient.getTrainingStatus.mockResolvedValue(sampleStatus);
  trainingClient.listTrainingTrajectories.mockResolvedValue(sampleTrajectories);
  trainingClient.getTrainingTrajectory.mockResolvedValue({
    trajectory: {
      ...sampleTrajectories.trajectories[0],
      stepsJson: "[]",
      aiJudgeReasoning: null,
    },
  });
  trainingClient.listTrainingDatasets.mockResolvedValue({
    datasets: [sampleDataset],
  });
  trainingClient.buildTrainingDataset.mockResolvedValue({
    dataset: sampleDataset,
  });
  trainingClient.listTrainingJobs.mockResolvedValue({ jobs: [sampleJob] });
  trainingClient.startTrainingJob.mockResolvedValue({ job: sampleJob });
  trainingClient.cancelTrainingJob.mockResolvedValue({ ok: true });
  trainingClient.listTrainingModels.mockResolvedValue({
    models: [sampleModel],
  });
  trainingClient.importTrainingModelToOllama.mockResolvedValue({
    model: sampleModel,
  });
  trainingClient.activateTrainingModel.mockResolvedValue({
    modelId: "model-1",
    providerModel: "ollama/eliza-model",
    needsRestart: false,
  });
  trainingClient.benchmarkTrainingModel.mockResolvedValue({
    status: "passed",
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FineTuningTuiView", () => {
  it("mounts training state and exposes TUI metadata", async () => {
    mockState();

    const { container } = render(React.createElement(FineTuningTuiView));

    await screen.findByText(/trajectory-1 calls 3 reward 0.9/);
    expect(screen.getByText(/job-1/)).toBeTruthy();
    expect(
      screen.getByText(/model-1 cpu active ollama eliza-model/),
    ).toBeTruthy();
    expect(trainingClient.listTrainingJobs).toHaveBeenCalled();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "training",
      runtimeAvailable: true,
      runningJobs: 1,
      queuedJobs: 1,
      datasetCount: 1,
      jobCount: 1,
      modelCount: 1,
      trajectoryCount: 1,
    });
  });

  it("supports terminal training capabilities", async () => {
    mockState();

    await expect(interact("terminal-training-state")).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      datasets: { datasets: [sampleDataset] },
      jobs: { jobs: [sampleJob] },
      models: { models: [sampleModel] },
    });

    await expect(
      interact("terminal-training-trajectory", {
        trajectoryId: "trajectory-1",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      trajectory: { trajectoryId: "trajectory-1" },
    });

    await expect(
      interact("terminal-training-build-dataset", {
        limit: 10,
        minLlmCallsPerTrajectory: 1,
      }),
    ).resolves.toMatchObject({ viewType: "tui", dataset: sampleDataset });

    await expect(
      interact("terminal-training-start-job", {
        datasetId: "dataset-1",
        backend: "cpu",
        iterations: 5,
      }),
    ).resolves.toMatchObject({ viewType: "tui", job: sampleJob });

    await expect(
      interact("terminal-training-cancel-job", { jobId: "job-1" }),
    ).resolves.toEqual({ viewType: "tui", ok: true });

    await expect(
      interact("terminal-training-import-model", {
        modelId: "model-1",
        modelName: "eliza-model",
      }),
    ).resolves.toMatchObject({ viewType: "tui", model: sampleModel });

    await expect(
      interact("terminal-training-activate-model", {
        modelId: "model-1",
        providerModel: "ollama/eliza-model",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      modelId: "model-1",
      providerModel: "ollama/eliza-model",
    });

    await expect(
      interact("terminal-training-benchmark-model", { modelId: "model-1" }),
    ).resolves.toEqual({ viewType: "tui", status: "passed" });
  });
});
