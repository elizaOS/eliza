// @vitest-environment jsdom

import type {
  TrainingDatasetRecord,
  TrainingJobRecord,
  TrainingModelRecord,
  TrainingTrajectoryList,
} from "@elizaos/app-core/api";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FineTuningContextStub {
  t: (key: string) => string;
  setState: (key: string, value: unknown) => void;
  handleRestart: () => Promise<void>;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
}

type WsPayload = Record<
  string,
  string | number | boolean | object | null | undefined
>;

const { mockClientFns, mockUseApp } = vi.hoisted(() => ({
  mockClientFns: {
    getCodingAgentStatus: vi.fn(async () => null),
    getTrainingStatus: vi.fn(),
    listTrainingTrajectories: vi.fn(),
    listTrainingDatasets: vi.fn(),
    listTrainingJobs: vi.fn(),
    listTrainingModels: vi.fn(),
    getTrainingTrajectory: vi.fn(),
    buildTrainingDataset: vi.fn(),
    startTrainingJob: vi.fn(),
    cancelTrainingJob: vi.fn(),
    importTrainingModelToOllama: vi.fn(),
    activateTrainingModel: vi.fn(),
    benchmarkTrainingModel: vi.fn(),
    sendChatRest: vi.fn(),
    onWsEvent: vi.fn(),
  },
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClientFns,
}));
vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

import { FineTuningView } from "../../src/components/FineTuningView";

function baseTrajectoryList(): TrainingTrajectoryList {
  return {
    available: true,
    total: 1,
    trajectories: [
      {
        id: "traj-row-1",
        trajectoryId: "trajectory-1",
        agentId: "agent-1",
        archetype: "default",
        createdAt: new Date(0).toISOString(),
        totalReward: 2,
        aiJudgeReward: 1,
        episodeLength: 4,
        hasLlmCalls: true,
        llmCallCount: 3,
      },
    ],
  };
}

function baseDataset(): TrainingDatasetRecord {
  return {
    id: "dataset-1",
    createdAt: new Date(0).toISOString(),
    jsonlPath: "/tmp/training-data.jsonl",
    trajectoryDir: "/tmp/trajectories",
    metadataPath: "/tmp/metadata.json",
    sampleCount: 42,
    trajectoryCount: 11,
  };
}

function baseJob(): TrainingJobRecord {
  return {
    id: "job-1",
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    completedAt: null,
    status: "running",
    phase: "training",
    progress: 0.4,
    error: null,
    exitCode: null,
    signal: null,
    options: {},
    datasetId: "dataset-1",
    pythonRoot: "/tmp/python",
    scriptPath: "/tmp/train.py",
    outputDir: "/tmp/out",
    logPath: "/tmp/job.log",
    modelPath: null,
    adapterPath: null,
    modelId: null,
    logs: ["training step 1"],
  };
}

function baseModel(): TrainingModelRecord {
  return {
    id: "model-1",
    createdAt: new Date(0).toISOString(),
    jobId: "job-1",
    outputDir: "/tmp/out",
    modelPath: "/tmp/out/model",
    adapterPath: "/tmp/out/adapter",
    sourceModel: "qwen",
    backend: "cpu",
    ollamaModel: null,
    active: false,
    benchmark: {
      status: "not_run",
      lastRunAt: null,
      output: null,
    },
  };
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : ""))
    .join("")
    .trim();
}

function findButtonByText(
  root: TestRenderer.ReactTestInstance,
  label: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.type === "button" && text(node) === label,
  );
  if (!matches[0]) throw new Error(`Button "${label}" not found`);
  return matches[0];
}

function findInputByPlaceholder(
  root: TestRenderer.ReactTestInstance,
  placeholder: string,
): TestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      (node.type === "input" || typeof node.type === "function") &&
      typeof node.props.placeholder === "string" &&
      node.props.placeholder.toLowerCase().includes(placeholder.toLowerCase()),
  );
  if (!matches[0]) throw new Error(`Input "${placeholder}" not found`);
  return matches[matches.length - 1];
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("FineTuningView", () => {
  let wsHandler: ((data: WsPayload) => void) | null;
  let appContext: FineTuningContextStub;

  beforeEach(() => {
    window.setInterval = globalThis.setInterval.bind(globalThis);
    window.clearInterval = globalThis.clearInterval.bind(globalThis);

    wsHandler = null;
    mockUseApp.mockReset();
    mockClientFns.getTrainingStatus.mockReset();
    mockClientFns.listTrainingTrajectories.mockReset();
    mockClientFns.listTrainingDatasets.mockReset();
    mockClientFns.listTrainingJobs.mockReset();
    mockClientFns.listTrainingModels.mockReset();
    mockClientFns.getTrainingTrajectory.mockReset();
    mockClientFns.buildTrainingDataset.mockReset();
    mockClientFns.startTrainingJob.mockReset();
    mockClientFns.cancelTrainingJob.mockReset();
    mockClientFns.importTrainingModelToOllama.mockReset();
    mockClientFns.activateTrainingModel.mockReset();
    mockClientFns.benchmarkTrainingModel.mockReset();
    mockClientFns.sendChatRest.mockReset();
    mockClientFns.onWsEvent.mockReset();

    appContext = {
      t: (k: string) => {
        if (k === "finetuningview.LimitTrajectories")
          return "Limit trajectories";
        if (k === "finetuningview.MinLLMCallsPerTr")
          return "Min LLM calls per trajectory";
        if (k === "finetuningview.OllamaModelNameO")
          return "Ollama model name (optional)";
        if (k === "finetuningview.BaseModelForOllam")
          return "Base model for Ollama (optional)";
        if (k === "finetuningview.ProviderModelEG")
          return 'Provider model (e.g. "ollama/my-model")';
        return k;
      },
      setState: vi.fn((_key, _value) => {
        // Mock implementation if needed, otherwise a no-op
      }),
      handleRestart: async () => undefined,
      setActionNotice: vi.fn<FineTuningContextStub["setActionNotice"]>(),
    };
    mockUseApp.mockReturnValue(appContext);

    mockClientFns.getTrainingStatus.mockResolvedValue({
      runningJobs: 0,
      queuedJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      modelCount: 1,
      datasetCount: 1,
      runtimeAvailable: true,
    });
    mockClientFns.listTrainingTrajectories.mockResolvedValue(
      baseTrajectoryList(),
    );
    mockClientFns.listTrainingDatasets.mockResolvedValue({
      datasets: [baseDataset()],
    });
    mockClientFns.listTrainingJobs.mockResolvedValue({ jobs: [baseJob()] });
    mockClientFns.listTrainingModels.mockResolvedValue({
      models: [baseModel()],
    });
    mockClientFns.getTrainingTrajectory.mockResolvedValue({
      trajectory: {
        ...baseTrajectoryList().trajectories[0],
        stepsJson: "[]",
        aiJudgeReasoning: null,
      },
    });
    mockClientFns.buildTrainingDataset.mockResolvedValue({
      dataset: baseDataset(),
    });
    mockClientFns.startTrainingJob.mockResolvedValue({ job: baseJob() });
    mockClientFns.cancelTrainingJob.mockResolvedValue({ job: baseJob() });
    mockClientFns.importTrainingModelToOllama.mockResolvedValue({
      model: { ...baseModel(), ollamaModel: "eliza-ft-model" },
    });
    mockClientFns.activateTrainingModel.mockResolvedValue({
      modelId: "model-1",
      providerModel: "ollama/eliza-ft-model",
      needsRestart: false,
    });
    mockClientFns.benchmarkTrainingModel.mockResolvedValue({
      status: "passed",
      output: "ok",
    });
    mockClientFns.sendChatRest.mockResolvedValue({
      text: "MODEL_OK",
      agentName: "Eliza",
    });
    mockClientFns.onWsEvent.mockImplementation(
      (_type: string, handler: (data: WsPayload) => void) => {
        wsHandler = handler;
        return () => undefined;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads training data on mount", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FineTuningView));
    });
    await flush();

    expect(mockClientFns.getTrainingStatus).toHaveBeenCalled();
    expect(mockClientFns.listTrainingTrajectories).toHaveBeenCalled();
    expect(mockClientFns.listTrainingDatasets).toHaveBeenCalled();
    expect(mockClientFns.listTrainingJobs).toHaveBeenCalled();
    expect(mockClientFns.listTrainingModels).toHaveBeenCalled();
    expect(
      tree?.root.findAll(
        (node) =>
          typeof node.type === "string" &&
          node.children.includes("finetuningview.FineTuning"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("builds dataset from form inputs", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FineTuningView));
    });
    await flush();

    const root = tree?.root;
    try {
      console.log("TREE DUMP:", JSON.stringify(tree?.toJSON(), null, 2));
    } catch {}
    const limitInput = findInputByPlaceholder(root, "Limit");
    const minCallsInput = findInputByPlaceholder(root, "Min LLM");
    await act(async () => {
      limitInput.props.onChange({ target: { value: "120" } });
      minCallsInput.props.onChange({ target: { value: "2" } });
    });
    await act(async () => {
      await findButtonByText(root, "Build Dataset").props.onClick();
    });

    expect(mockClientFns.buildTrainingDataset).toHaveBeenCalledWith({
      limit: 120,
      minLlmCallsPerTrajectory: 2,
    });
    expect(appContext.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Built dataset"),
      "success",
      3800,
    );
  });

  it("shows error notice when starting a training job fails", async () => {
    mockClientFns.startTrainingJob.mockRejectedValueOnce(new Error("boom"));
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FineTuningView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "Start Training Job").props.onClick();
    });
    expect(appContext.setActionNotice).toHaveBeenCalledWith(
      "boom",
      "error",
      4200,
    );
  });

  it("starts a training job and handles live training events", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FineTuningView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "Start Training Job").props.onClick();
    });
    expect(mockClientFns.startTrainingJob).toHaveBeenCalled();

    expect(wsHandler).not.toBeNull();
    await act(async () => {
      wsHandler?.({
        type: "training_event",
        payload: {
          kind: "job_progress",
          ts: Date.now(),
          message: "training step",
          jobId: "job-1",
          progress: 0.5,
          phase: "training",
        },
      });
    });
    const eventRows = tree?.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        node.children.some(
          (child) =>
            typeof child === "string" && child.includes("training step"),
        ),
    );
    expect(eventRows.length).toBeGreaterThan(0);
  });

  it("cancels an active job", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FineTuningView));
    });
    await flush();

    await act(async () => {
      await findButtonByText(tree?.root, "Cancel").props.onClick();
    });

    expect(mockClientFns.cancelTrainingJob).toHaveBeenCalledWith("job-1");
    expect(appContext.setActionNotice).toHaveBeenCalledWith(
      "Cancelled job job-1.",
      "success",
      2600,
    );
  });

  it("imports, activates, benchmarks, and smoke-tests selected model", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FineTuningView));
    });
    await flush();

    const root = tree?.root;

    const ollamaNameInput = findInputByPlaceholder(root, "Ollama model name");
    const baseModelInput = findInputByPlaceholder(
      root,
      "Base model for Ollama",
    );
    const providerModelInput = findInputByPlaceholder(root, "Provider model");

    await act(async () => {
      ollamaNameInput.props.onChange({ target: { value: "eliza-ft-model" } });
      baseModelInput.props.onChange({
        target: { value: "qwen2.5:7b-instruct" },
      });
      providerModelInput.props.onChange({
        target: { value: "ollama/eliza-ft-model" },
      });
    });

    await act(async () => {
      await findButtonByText(root, "Import To Ollama").props.onClick();
    });
    expect(mockClientFns.importTrainingModelToOllama).toHaveBeenCalledWith(
      "model-1",
      {
        modelName: "eliza-ft-model",
        baseModel: "qwen2.5:7b-instruct",
        ollamaUrl: "http://localhost:11434",
      },
    );

    await act(async () => {
      await findButtonByText(root, "Activate Model").props.onClick();
    });
    expect(mockClientFns.activateTrainingModel).toHaveBeenCalledWith(
      "model-1",
      "ollama/eliza-ft-model",
    );

    await act(async () => {
      await findButtonByText(root, "Benchmark").props.onClick();
    });
    expect(mockClientFns.benchmarkTrainingModel).toHaveBeenCalledWith(
      "model-1",
    );

    await act(async () => {
      await findButtonByText(root, "Run Smoke Prompt").props.onClick();
    });
    expect(mockClientFns.sendChatRest).toHaveBeenCalledWith(
      "Model smoke test. Reply with exactly: MODEL_OK",
    );
  });
});
