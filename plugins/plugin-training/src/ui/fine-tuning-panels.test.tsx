// @vitest-environment jsdom

// Real-panel coverage for the fine-tuning dashboard GUI. The sibling
// FineTuningTuiView.test.tsx stubs every panel from ./fine-tuning-panels.js, so
// none of the panel data display or controls are asserted there. This file
// renders the ACTUAL panel components with realistic fixture props and asserts
// the populated rows render and that every interactive control fires its
// callback / setter. Only the @elizaos/ui primitives the panels import are
// mocked (Button, Input, Select*, SettingsControls) — never the panels.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { reactEntry } = vi.hoisted(() => {
  const { createRequire } =
    require("node:module") as typeof import("node:module");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  const requireFromHere = createRequire(fileURLToPath(import.meta.url));
  return { reactEntry: requireFromHere.resolve("react") };
});

vi.mock("react", async () => await import(reactEntry));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  // Mirror the real hook: it stamps data-agent-* attributes (not aria-label) for
  // list-item controls, so tests can target rows the same way production does.
  useAgentElement: (descriptor: {
    id: string;
    role?: string;
    label: string;
  }) => ({
    ref: { current: null },
    agentProps: {
      "data-agent-id": descriptor.id,
      "data-agent-role": descriptor.role ?? "region",
      "data-agent-label": descriptor.label,
    },
  }),
}));

vi.mock("@elizaos/ui/components", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
}));

vi.mock("@elizaos/ui/components/ui/select", () => ({
  // Native-select stand-in so onValueChange can be driven via change events. The
  // accessible name is lifted off the SettingsControls.SelectTrigger child (which
  // carries the agent label) onto the native <select> so getByLabelText works.
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => {
    let ariaLabel: string | undefined;
    for (const child of React.Children.toArray(children)) {
      if (
        React.isValidElement(child) &&
        typeof (child.props as { "aria-label"?: string })["aria-label"] ===
          "string"
      ) {
        ariaLabel = (child.props as { "aria-label"?: string })["aria-label"];
      }
    }
    return React.createElement(
      "select",
      {
        value,
        "aria-label": ariaLabel,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange(event.target.value),
      },
      children,
    );
  },
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, {}, children),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => React.createElement("option", { value }, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) =>
    React.createElement(React.Fragment, {}, placeholder ?? null),
}));

vi.mock("@elizaos/ui/components/ui/settings-controls", () => ({
  SettingsControls: {
    // The trigger renders inside the mocked native <select>; jsdom rejects nested
    // elements there, and the <option> list (rendered by SelectContent) is the
    // interactive surface, so the trigger renders nothing.
    SelectTrigger: () => null,
    Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
      React.createElement("textarea", props),
  },
}));

vi.mock("@elizaos/ui/utils", () => ({
  formatTime: (ts: number) => `ts:${ts}`,
}));

import type {
  TrainingDatasetRecord,
  TrainingJobRecord,
  TrainingModelRecord,
  TrainingStreamEvent,
  TrainingTrajectoryDetail,
  TrainingTrajectoryList,
} from "@elizaos/ui/api";
import {
  DatasetSection,
  LiveEventsPanel,
  SelectedJobPanel,
  SelectedModelPanel,
  TrainedModelsSection,
  TrainingJobsSection,
  TrajectoriesSection,
} from "./fine-tuning-panels.js";

const t = (key: string) => key;

// List-item controls (job/model/trajectory rows, radio items) are labelled via
// the agent-surface data-agent-label attribute, not aria-label.
function byAgentLabel(label: string): HTMLElement {
  const node = document.querySelector(`[data-agent-label="${label}"]`);
  if (!node) throw new Error(`No element with data-agent-label="${label}"`);
  return node as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const trajectoryList: TrainingTrajectoryList = {
  available: true,
  total: 2,
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
    {
      id: "summary-2",
      trajectoryId: "trajectory-2",
      agentId: "agent-1",
      archetype: null,
      createdAt: "2026-05-18T13:00:00.000Z",
      totalReward: null,
      aiJudgeReward: null,
      episodeLength: 2,
      hasLlmCalls: true,
      llmCallCount: 7,
    },
  ],
};

const selectedTrajectory: TrainingTrajectoryDetail = {
  ...trajectoryList.trajectories[0],
  stepsJson: '[{"role":"user","content":"hi"}]',
  aiJudgeReasoning: null,
};

const dataset: TrainingDatasetRecord = {
  id: "dataset-1",
  createdAt: "2026-05-18T12:00:00.000Z",
  jsonlPath: "/tmp/dataset.jsonl",
  trajectoryDir: "/tmp/trajectories",
  metadataPath: "/tmp/metadata.json",
  sampleCount: 12,
  trajectoryCount: 3,
};

const job: TrainingJobRecord = {
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
  logs: ["step 1", "step 2"],
};

const model: TrainingModelRecord = {
  id: "model-1",
  createdAt: "2026-05-18T12:00:00.000Z",
  jobId: "job-1",
  outputDir: "/tmp/out",
  modelPath: "/tmp/model",
  adapterPath: "/tmp/adapter",
  sourceModel: "base-model",
  backend: "cpu",
  ollamaModel: "eliza-model",
  active: true,
  benchmark: { status: "passed", lastRunAt: null, output: null },
};

const noop = () => undefined;

describe("TrajectoriesSection", () => {
  it("renders populated trajectory rows, the selected-trajectory detail, and fires every control", () => {
    const onRefresh = vi.fn();
    const onSelectTrajectory = vi.fn();
    const onPublishTrajectories = vi.fn();

    render(
      React.createElement(TrajectoriesSection, {
        trajectoryList,
        selectedTrajectory,
        trajectoryLoading: false,
        publishingTrajectories: false,
        publishConfigured: true,
        onRefresh,
        onSelectTrajectory,
        onPublishTrajectories,
        t,
      }),
    );

    // Populated row data: id + calls + reward.
    const row1 = byAgentLabel("Trajectory trajectory-1");
    expect(row1.textContent).toContain("trajectory-1");
    expect(row1.textContent).toContain("3");
    expect(row1.textContent).toContain("0.9");
    const row2 = byAgentLabel("Trajectory trajectory-2");
    // null reward renders "n/a", call count 7.
    expect(row2.textContent).toContain("7");
    expect(row2.textContent).toContain("n/a");
    // total count header (text is split across nodes: "{total} {label}").
    expect(
      screen.getByText((_content, node) =>
        Boolean(
          node?.textContent === "2 finetuningview.trajectoryRowsAvai" &&
            node.tagName === "DIV",
        ),
      ),
    ).toBeTruthy();

    // Selected-trajectory detail panel: id / agent / reward / stepsJson textarea.
    expect(
      screen.getAllByText("trajectory-1").some((node) => node.tagName === "SPAN"),
    ).toBe(true);
    expect(screen.getByText("agent-1")).toBeTruthy();
    const textarea = document.querySelector(
      "textarea",
    ) as HTMLTextAreaElement | null;
    expect(textarea?.value).toBe('[{"role":"user","content":"hi"}]');

    // Controls.
    fireEvent.click(screen.getByLabelText("Refresh trajectories"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Publish trajectories to HuggingFace"));
    expect(onPublishTrajectories).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("trajectory-2"));
    expect(onSelectTrajectory).toHaveBeenCalledWith("trajectory-2");
  });

  it("disables Publish when publishConfigured is false and renders the empty state", () => {
    render(
      React.createElement(TrajectoriesSection, {
        trajectoryList: { available: true, total: 0, trajectories: [] },
        selectedTrajectory: null,
        trajectoryLoading: false,
        publishingTrajectories: false,
        publishConfigured: false,
        onRefresh: noop,
        onSelectTrajectory: noop,
        onPublishTrajectories: noop,
        t,
      }),
    );

    expect(
      (
        screen.getByLabelText(
          "Publish trajectories to HuggingFace",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("finetuningview.NoTrajectoriesFoun")).toBeTruthy();
    expect(screen.getByText("finetuningview.ChooseATrajectory")).toBeTruthy();
  });

  it("shows the unavailable reason when the trajectory list is unavailable", () => {
    render(
      React.createElement(TrajectoriesSection, {
        trajectoryList: {
          available: false,
          reason: "runtime_not_started",
          total: 0,
          trajectories: [],
        },
        selectedTrajectory: null,
        trajectoryLoading: false,
        publishingTrajectories: false,
        publishConfigured: true,
        onRefresh: noop,
        onSelectTrajectory: noop,
        onPublishTrajectories: noop,
        t,
      }),
    );

    expect(screen.getByText("finetuningview.RuntimeNotStarted")).toBeTruthy();
  });
});

describe("DatasetSection", () => {
  it("renders each dataset row, fires build/refresh, the two inputs, and radio select", () => {
    const onBuildDataset = vi.fn();
    const onRefreshDatasets = vi.fn();
    const setBuildLimit = vi.fn();
    const setBuildMinCalls = vi.fn();
    const setSelectedDatasetId = vi.fn();

    render(
      React.createElement(DatasetSection, {
        buildLimit: "10",
        setBuildLimit,
        buildMinCalls: "2",
        setBuildMinCalls,
        datasetBuilding: false,
        datasets: [dataset],
        selectedDatasetId: "",
        setSelectedDatasetId,
        onBuildDataset,
        onRefreshDatasets,
        t,
      }),
    );

    // Row data: id + sampleCount + trajectoryCount.
    expect(screen.getByText("dataset-1")).toBeTruthy();
    const row = screen.getByText("dataset-1").closest("label");
    expect(row?.textContent).toContain("12");
    expect(row?.textContent).toContain("3");

    fireEvent.click(screen.getByLabelText("Build dataset"));
    expect(onBuildDataset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Refresh datasets"));
    expect(onRefreshDatasets).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Limit trajectories"), {
      target: { value: "25" },
    });
    expect(setBuildLimit).toHaveBeenCalledWith("25");
    fireEvent.change(screen.getByLabelText("Min LLM calls per trajectory"), {
      target: { value: "5" },
    });
    expect(setBuildMinCalls).toHaveBeenCalledWith("5");

    // Radio select.
    const radio = row?.querySelector(
      "input[type=radio]",
    ) as HTMLInputElement | null;
    expect(radio).toBeTruthy();
    fireEvent.click(radio as HTMLInputElement);
    expect(setSelectedDatasetId).toHaveBeenCalledWith("dataset-1");
  });

  it("renders the empty state when there are no datasets", () => {
    render(
      React.createElement(DatasetSection, {
        buildLimit: "",
        setBuildLimit: noop,
        buildMinCalls: "",
        setBuildMinCalls: noop,
        datasetBuilding: false,
        datasets: [],
        selectedDatasetId: "",
        setSelectedDatasetId: noop,
        onBuildDataset: noop,
        onRefreshDatasets: noop,
        t,
      }),
    );
    expect(screen.getByText("finetuningview.NoDatasetsYet")).toBeTruthy();
  });
});

describe("TrainingJobsSection", () => {
  function renderJobs(
    overrides: Partial<React.ComponentProps<typeof TrainingJobsSection>> = {},
  ) {
    const props: React.ComponentProps<typeof TrainingJobsSection> = {
      selectedDatasetId: "__auto__",
      setSelectedDatasetId: vi.fn(),
      datasets: [dataset],
      startBackend: "cpu",
      setStartBackend: vi.fn(),
      startModel: "base",
      setStartModel: vi.fn(),
      startIterations: "100",
      setStartIterations: vi.fn(),
      startBatchSize: "8",
      setStartBatchSize: vi.fn(),
      startLearningRate: "0.001",
      setStartLearningRate: vi.fn(),
      startingJob: false,
      activeRunningJob: null,
      jobs: [job],
      selectedJobId: "job-1",
      setSelectedJobId: vi.fn(),
      cancellingJobId: "",
      selectedJob: job,
      onStartJob: vi.fn(),
      onRefreshJobs: vi.fn(),
      onCancelJob: vi.fn(),
      t,
      ...overrides,
    };
    render(React.createElement(TrainingJobsSection, props));
    return props;
  }

  it("renders job rows + SelectedJobPanel detail and fires start/refresh/cancel", () => {
    const props = renderJobs();

    // Job row shows id, status, progress, phase. The select button sits in the
    // flex header; its grandparent is the JobListItem wrapper holding the status.
    const jobSelect = byAgentLabel("Select job job-1");
    const jobRow = jobSelect.closest("div")?.parentElement;
    expect(jobRow?.textContent).toContain("running");
    expect(jobRow?.textContent).toContain("50%");
    expect(jobRow?.textContent).toContain("train");

    // SelectedJobPanel detail (status / dataset / logs textarea). dataset-1 also
    // appears as a <select> option, so target the detail's font-mono span.
    expect(screen.getByText("finetuningview.Status1")).toBeTruthy();
    expect(
      screen
        .getAllByText("dataset-1")
        .some((node) => node.tagName === "SPAN"),
    ).toBe(true);
    const textarea = document.querySelector(
      "textarea",
    ) as HTMLTextAreaElement | null;
    expect(textarea?.value).toBe("step 1\nstep 2");

    fireEvent.click(screen.getByLabelText("Start training job"));
    expect(props.onStartJob).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Refresh jobs"));
    expect(props.onRefreshJobs).toHaveBeenCalledTimes(1);
    // Cancel button only shows for running/queued jobs (labelled via agent-surface).
    fireEvent.click(byAgentLabel("Cancel job job-1"));
    expect(props.onCancelJob).toHaveBeenCalledWith("job-1");
  });

  it("fires the config selects and numeric inputs", () => {
    const props = renderJobs();

    fireEvent.change(screen.getByLabelText("Training backend"), {
      target: { value: "cuda" },
    });
    expect(props.setStartBackend).toHaveBeenCalledWith("cuda");
    fireEvent.change(screen.getByLabelText("Training dataset"), {
      target: { value: "dataset-1" },
    });
    expect(props.setSelectedDatasetId).toHaveBeenCalledWith("dataset-1");

    fireEvent.change(screen.getByLabelText("Base model"), {
      target: { value: "eliza-base" },
    });
    expect(props.setStartModel).toHaveBeenCalledWith("eliza-base");
    fireEvent.change(screen.getByLabelText("Iterations"), {
      target: { value: "250" },
    });
    expect(props.setStartIterations).toHaveBeenCalledWith("250");
    fireEvent.change(screen.getByLabelText("Batch size"), {
      target: { value: "16" },
    });
    expect(props.setStartBatchSize).toHaveBeenCalledWith("16");
    fireEvent.change(screen.getByLabelText("Learning rate"), {
      target: { value: "0.0005" },
    });
    expect(props.setStartLearningRate).toHaveBeenCalledWith("0.0005");
  });

  it("disables Start and surfaces the active-job banner when a job is running", () => {
    renderJobs({ activeRunningJob: job });
    expect(
      (screen.getByLabelText("Start training job") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("finetuningview.ActiveJob")).toBeTruthy();
  });

  it("renders the empty job state", () => {
    renderJobs({ jobs: [], selectedJob: null });
    expect(screen.getByText("finetuningview.NoJobsYet")).toBeTruthy();
    expect(screen.getByText("finetuningview.SelectAJobToInsp")).toBeTruthy();
  });
});

describe("TrainedModelsSection + SelectedModelPanel", () => {
  function renderModels(
    overrides: Partial<React.ComponentProps<typeof TrainedModelsSection>> = {},
  ) {
    const props: React.ComponentProps<typeof TrainedModelsSection> = {
      activateProviderModel: "ollama/eliza-model",
      importBaseModel: "base",
      importModelName: "eliza-model",
      importOllamaUrl: "http://localhost:11434",
      modelAction: "",
      models: [model],
      onActivate: vi.fn(),
      onBenchmark: vi.fn(),
      onImport: vi.fn(),
      onSmokeTest: vi.fn(),
      selectedModel: model,
      selectedModelId: "model-1",
      setActivateProviderModel: vi.fn(),
      setImportBaseModel: vi.fn(),
      setImportModelName: vi.fn(),
      setImportOllamaUrl: vi.fn(),
      setSelectedModelId: vi.fn(),
      smokeResult: "smoke ok output",
      t,
      ...overrides,
    };
    render(React.createElement(TrainedModelsSection, props));
    return props;
  }

  it("renders model list (active/ollama/backend) + detail and fires every action + import setter", () => {
    const props = renderModels();

    // List row shows id + active indicator + backend + ollama model.
    const listRow = byAgentLabel("Select model model-1");
    expect(listRow.textContent).toContain("model-1");
    expect(listRow.textContent).toContain("finetuningview.ActiveIndicator");
    expect(listRow.textContent).toContain("cpu");
    expect(listRow.textContent).toContain("ollama: eliza-model");

    // SelectedModelPanel shows adapter path + smoke result.
    expect(screen.getByText("/tmp/adapter")).toBeTruthy();
    const textarea = document.querySelector(
      "textarea",
    ) as HTMLTextAreaElement | null;
    expect(textarea?.value).toBe("smoke ok output");

    // Actions.
    fireEvent.click(screen.getByLabelText("Import to Ollama"));
    expect(props.onImport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Activate model"));
    expect(props.onActivate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Benchmark model"));
    expect(props.onBenchmark).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Run smoke prompt"));
    expect(props.onSmokeTest).toHaveBeenCalledTimes(1);

    // Import inputs + provider model.
    fireEvent.change(screen.getByLabelText("Ollama model name"), {
      target: { value: "my-model" },
    });
    expect(props.setImportModelName).toHaveBeenCalledWith("my-model");
    fireEvent.change(screen.getByLabelText("Base model for Ollama"), {
      target: { value: "llama3" },
    });
    expect(props.setImportBaseModel).toHaveBeenCalledWith("llama3");
    fireEvent.change(screen.getByLabelText("Ollama URL"), {
      target: { value: "http://host:1234" },
    });
    expect(props.setImportOllamaUrl).toHaveBeenCalledWith("http://host:1234");
    fireEvent.change(screen.getByLabelText("Provider model"), {
      target: { value: "ollama/new-model" },
    });
    expect(props.setActivateProviderModel).toHaveBeenCalledWith(
      "ollama/new-model",
    );
  });

  it("fires onSelect when a model row is clicked", () => {
    const props = renderModels({ selectedModelId: "", selectedModel: null });
    fireEvent.click(byAgentLabel("Select model model-1"));
    expect(props.setSelectedModelId).toHaveBeenCalledWith("model-1");
    // No selection -> import/activate panel placeholder.
    expect(screen.getByText("finetuningview.SelectAModelToIm")).toBeTruthy();
  });

  it("renders the empty model state", () => {
    renderModels({ models: [], selectedModel: null });
    expect(screen.getByText("finetuningview.NoTrainedModelsYe")).toBeTruthy();
  });

  it("reflects in-flight import state on the import button label", () => {
    renderModels({ modelAction: "import:model-1" });
    const importButton = screen.getByLabelText(
      "Import to Ollama",
    ) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    expect(importButton.textContent).toBe("finetuningview.Importing");
  });
});

describe("SelectedJobPanel", () => {
  it("renders the placeholder when no job is selected", () => {
    render(React.createElement(SelectedJobPanel, { selectedJob: null, t }));
    expect(screen.getByText("finetuningview.SelectAJobToInsp")).toBeTruthy();
  });
});

describe("SelectedModelPanel", () => {
  it("hides the smoke-result textarea when there is no smoke result", () => {
    render(
      React.createElement(SelectedModelPanel, {
        selectedModel: model,
        importModelName: "",
        setImportModelName: noop,
        importBaseModel: "",
        setImportBaseModel: noop,
        importOllamaUrl: "",
        setImportOllamaUrl: noop,
        activateProviderModel: "",
        setActivateProviderModel: noop,
        modelAction: "",
        smokeResult: null,
        onImport: noop,
        onActivate: noop,
        onBenchmark: noop,
        onSmokeTest: noop,
        t,
      }),
    );
    // Three import inputs are present, but no smoke-result textarea.
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("LiveEventsPanel", () => {
  it("renders each event's kind/phase/progress/message", () => {
    const events: TrainingStreamEvent[] = [
      {
        kind: "job_progress",
        ts: 1_700_000_000_000,
        message: "training step complete",
        jobId: "job-1",
        progress: 0.42,
        phase: "train",
      },
      {
        kind: "model_activated",
        ts: 1_700_000_100_000,
        message: "model now active",
        modelId: "model-1",
      },
    ];
    render(React.createElement(LiveEventsPanel, { events, t }));

    const first = screen.getByText("job_progress").closest("div");
    expect(first?.textContent).toContain("ts:1700000000000");
    expect(first?.textContent).toContain("42%");
    expect(first?.textContent).toContain("train");
    expect(within(first as HTMLElement).getByText("training step complete"))
      .toBeTruthy();

    const second = screen.getByText("model_activated").closest("div");
    expect(second?.textContent).toContain("model now active");
  });

  it("renders the empty state for no events", () => {
    render(React.createElement(LiveEventsPanel, { events: [], t }));
    expect(screen.getByText("finetuningview.NoLiveEventsYet")).toBeTruthy();
  });
});
