// @vitest-environment jsdom

// View-level coverage for the GUI Analysis panel. This file renders the real
// FineTuningView, clicks the GUI Build-index button, and asserts the populated
// coverage panel for both parser branches (manifest.coverage vs artifact
// aggregation).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

// Single shared app-state ref so the legacy `useApp` API and the per-slice
// `useAppSelector` reads the migrated view now uses both resolve to the same
// value.
const fineTuningAppState = vi.hoisted(() => ({
  handleRestart: vi.fn(),
  setActionNotice: vi.fn(),
  t: (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

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
  buildTrainingAnalysisIndex: vi.fn(),
  buildTrainingReadinessReport: vi.fn(),
  ingestHuggingFaceTrainingDataset: vi.fn(),
  runFeedTrainingGeneration: vi.fn(),
  runTrainingScenarios: vi.fn(),
  runTrainingLocalEvalComparison: vi.fn(),
  runTrainingCollection: vi.fn(),
  listTrainingCollections: vi.fn(),
  writeTrainingBenchmarkMatrix: vi.fn(),
  runTrainingBenchmarkVsCerebras: vi.fn(),
  stageEliza1Bundle: vi.fn(),
  runTrainingActionBenchmark: vi.fn(),
  onWsEvent: vi.fn(() => () => undefined),
  sendChatRest: vi.fn(),
}));

// FineTuningView's own @elizaos/ui surface.
vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  client: trainingClient,
  registerDetailExtension: vi.fn(),
  useApp: () => fineTuningAppState,
  useAppSelector: <T,>(selector: (s: typeof fineTuningAppState) => T): T =>
    selector(fineTuningAppState),
}));

vi.mock("@elizaos/ui/api", () => ({
  client: trainingClient,
}));

vi.mock("@elizaos/ui/api/index", () => ({
  client: trainingClient,
}));

vi.mock("../../../../packages/ui/src/api/index.ts", () => ({
  client: trainingClient,
}));

// FineTuningView reads useApp/useAppSelector from @elizaos/ui/state (not the
// root barrel), so the mock must cover that subpath too — otherwise the real
// store runs, `t` returns raw i18n keys, and label/aria-label lookups fail.
vi.mock("@elizaos/ui/state", () => ({
  useApp: () => fineTuningAppState,
  useAppSelector: <T,>(selector: (s: typeof fineTuningAppState) => T): T =>
    selector(fineTuningAppState),
}));

vi.mock("@elizaos/ui/state/index", () => ({
  useApp: () => fineTuningAppState,
  useAppSelector: <T,>(selector: (s: typeof fineTuningAppState) => T): T =>
    selector(fineTuningAppState),
}));

vi.mock("../../../../packages/ui/src/state/index.ts", () => ({
  useApp: () => fineTuningAppState,
  useAppSelector: <T,>(selector: (s: typeof fineTuningAppState) => T): T =>
    selector(fineTuningAppState),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
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

vi.mock("@elizaos/ui/hooks", () => ({
  useIntervalWhenDocumentVisible: vi.fn(),
}));

vi.mock("@elizaos/ui/layouts", () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
}));

vi.mock("@elizaos/ui/utils", () => ({
  confirmDesktopAction: vi.fn(),
  openExternalUrl: vi.fn(),
  parsePositiveFloat: (value: string) => Number.parseFloat(value),
  parsePositiveInteger: (value: string) => Number.parseInt(value, 10),
}));

// Primitives FineTuningView imports straight from the barrel — its own
// AgentTextAreaField/AgentNativeSelect render Textarea and the Select family
// from here (the sub-panels reach for the /ui/select and /ui/settings-controls
// subpaths mocked below). Every barrel symbol the view references must be
// present or vitest's mock proxy throws "No <name> export" and aborts the whole
// render before any assertion can run.
vi.mock("@elizaos/ui/components", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  registerDetailExtension: vi.fn(),
  Select: ({ children }: { children: React.ReactNode }) =>
    React.createElement("select", {}, children),
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, {}, children),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => React.createElement("option", { value }, children),
  SelectTrigger: () => null,
  SelectValue: () => null,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
    React.createElement("textarea", props),
}));

vi.mock("@elizaos/ui/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) =>
    React.createElement("select", {}, children),
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, {}, children),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => React.createElement("option", { value }, children),
  SelectValue: () => null,
}));

vi.mock("@elizaos/ui/components/ui/settings-controls", () => ({
  SettingsControls: {
    SelectTrigger: () => null,
    Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
      React.createElement("textarea", props),
  },
}));

import type { TrainingAnalysisIndexResponse } from "@elizaos/ui/api";
import { FineTuningView } from "./FineTuningView";

const baseStatus = {
  runningJobs: 0,
  queuedJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  modelCount: 0,
  datasetCount: 0,
  runtimeAvailable: true,
};

const emptyList = { available: true, total: 0, trajectories: [] };

function mockBaselineState() {
  trainingClient.getTrainingStatus.mockResolvedValue(baseStatus);
  trainingClient.listTrainingTrajectories.mockResolvedValue(emptyList);
  trainingClient.listTrainingDatasets.mockResolvedValue({ datasets: [] });
  trainingClient.listTrainingJobs.mockResolvedValue({ jobs: [] });
  trainingClient.listTrainingModels.mockResolvedValue({ models: [] });
  trainingClient.listTrainingCollections.mockResolvedValue({
    root: "/tmp/collections",
    indexJsonPath: "/tmp/collections/index.json",
    indexHtmlPath: "/tmp/collections/index.html",
    collections: [],
  });
}

// manifest.coverage-shaped response → first branch of summarizeAnalysisCoverage.
const manifestCoverageIndex: TrainingAnalysisIndexResponse = {
  outputDir: "/tmp/analysis-mc",
  indexHtmlPath: "/tmp/analysis-mc/index.html",
  manifestPath: "/tmp/analysis-mc/analysis-manifest.json",
  manifest: {
    schema: "eliza_training_analysis_index",
    schemaVersion: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    roots: ["/tmp"],
    outputDir: "/tmp/analysis-mc",
    indexHtmlPath: "/tmp/analysis-mc/index.html",
    manifestPath: "/tmp/analysis-mc/analysis-manifest.json",
    counts: { artifacts: 1 },
    coverage: {
      dataSources: {
        huggingFace: 3,
        feed: 2,
        natural: 4,
        scenarios: 1,
        tests: 5,
        trainingJsonl: 6,
      },
      readableSamples: {
        huggingFace: 30,
        feed: 20,
        natural: 40,
        scenarios: 10,
        tests: 50,
        trainingJsonl: 60,
        total: 210,
      },
      evals: { artifacts: 7 },
      benchmarks: {
        matrices: 8,
        allEliza1TiersCovered: true,
        tierCoverage: [
          {
            tier: "2b",
            hasBase: true,
            hasTrained: true,
            hasReference: true,
            hasImprovement: true,
          },
        ],
      },
      models: {
        artifacts: 9,
        inventory: [{ model: "a" }, { model: "b" }],
      },
    },
    artifacts: [
      {
        id: "benchmark:/tmp/benchmark.json",
        kind: "benchmark_matrix",
        title: "benchmark",
        path: "/tmp/benchmark.json",
        summary: { schema: "eliza_benchmark_matrix_artifact" },
        payload: {
          comparisons: [
            {
              tier: "2b",
              benchmark: "eliza_harness_action_selection",
              baseScore: 0.4,
              trainedScore: 0.5,
              referenceScore: 0.8,
              improvementPercent: 25,
              trainedVsReferencePercent: -37.5,
            },
          ],
        },
      },
    ],
  },
} as unknown as TrainingAnalysisIndexResponse;

// Artifact-aggregation-shaped response (NO manifest.coverage) → fallback branch.
const artifactAggregationIndex: TrainingAnalysisIndexResponse = {
  outputDir: "/tmp/analysis-aa",
  indexHtmlPath: "/tmp/analysis-aa/index.html",
  manifestPath: "/tmp/analysis-aa/analysis-manifest.json",
  manifest: {
    schema: "eliza_training_analysis_index",
    version: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    roots: ["/tmp"],
    outputDir: "/tmp/analysis-aa",
    counts: { artifacts: 9 },
    artifacts: [
      {
        id: "hf:/tmp/hf.json",
        kind: "trajectory_dataset",
        title: "hf",
        path: "/tmp/hf.json",
        summary: {
          schema: "eliza_huggingface_dataset_ingest",
          source: { kind: "huggingface_dataset" },
          hfSamplePreviews: [
            { trajectoryId: "hf-1" },
            { trajectoryId: "hf-2" },
          ],
        },
        payload: {},
      },
      {
        id: "feed:/tmp/feed.json",
        kind: "trajectory_dataset",
        title: "feed",
        path: "/tmp/feed.json",
        summary: {
          schema: "feed_parallel_generation",
          source: { kind: "feed_train_parallel_generation" },
          feedSamplePreviews: [{ trajectoryId: "feed-1" }],
        },
        payload: {},
      },
      {
        id: "bundle:/tmp/bundle.json",
        kind: "trajectory_bundle",
        title: "natural",
        path: "/tmp/bundle.json",
        summary: {
          source: "training_collection_natural_trajectories",
          samplePreviews: [
            { trajectoryId: "nat-1" },
            { trajectoryId: "nat-2" },
            { trajectoryId: "nat-3" },
          ],
        },
        payload: {},
      },
      {
        id: "scenario:/tmp/scenario.json",
        kind: "scenario_run",
        title: "scenario",
        path: "/tmp/scenario.json",
        summary: { turnPreviews: [{ scenarioId: "s1" }] },
        payload: {},
      },
      {
        id: "test:/tmp/test.json",
        kind: "trajectory_dataset",
        title: "test trajectory",
        path: "/tmp/test.json",
        summary: {
          schema: "eliza_test_trajectory_record",
          source: { kind: "app_core_test_trajectory" },
          testSamplePreviews: [{ scenarioId: "t1" }],
        },
        payload: {},
      },
      {
        id: "jsonl:/tmp/train.jsonl",
        kind: "trajectory_dataset",
        title: "train",
        path: "/tmp/train.jsonl",
        summary: {
          schema: "eliza_training_jsonl_dataset",
          samplePreviews: [
            { trajectoryId: "j-1" },
            { trajectoryId: "j-2" },
            { trajectoryId: "j-3" },
            { trajectoryId: "j-4" },
          ],
        },
        payload: {},
      },
      {
        id: "eval:/tmp/eval.json",
        kind: "eval",
        title: "eval.json",
        path: "/tmp/eval.json",
        summary: { schema: "eliza_training_readiness_report" },
        payload: {},
      },
      {
        id: "benchmark:/tmp/benchmark.json",
        kind: "benchmark_matrix",
        title: "benchmark",
        path: "/tmp/benchmark.json",
        summary: {
          schema: "eliza_benchmark_matrix_artifact",
          modelStats: [
            { modelId: "eliza-1-2b-base", averageScore: 0.4 },
            { modelId: "eliza-1-2b-trained", averageScore: 0.72 },
          ],
        },
        payload: {
          comparisons: [
            {
              tier: "2b",
              benchmark: "eliza_harness_action_selection",
              baseScore: 0.4,
              trainedScore: 0.5,
              referenceScore: 0.8,
              improvementPercent: 25,
              trainedVsReferencePercent: -37.5,
            },
          ],
        },
      },
      {
        id: "model:/tmp/model.json",
        kind: "model",
        title: "model",
        path: "/tmp/model.json",
        summary: { model: "eliza-1-2b-trained" },
        payload: {},
      },
    ],
  },
} as unknown as TrainingAnalysisIndexResponse;

// Match against the panel div whose concatenated textContent equals the expected
// font-mono summary string (React splits "{label}:{value}" across text nodes).
function expectMonoLine(expected: string) {
  return screen.getByText((_content, node) => {
    if (node?.tagName !== "DIV") return false;
    const normalized = node.textContent?.replace(/\s+/g, " ").trim();
    return normalized === expected;
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FineTuningView analysis coverage panel", () => {
  it("renders populated coverage from a manifest.coverage response (parser branch 1)", async () => {
    mockBaselineState();
    trainingClient.buildTrainingAnalysisIndex.mockResolvedValue(
      manifestCoverageIndex,
    );

    render(React.createElement(FineTuningView));

    const statusHeading = await screen.findByText("finetuningview.Status");
    const statusGrid = statusHeading.parentElement?.nextElementSibling;
    expect(statusGrid?.className).toContain(
      "grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))]",
    );

    // No coverage before the index is built.
    expect(
      await screen.findByText("finetuningview.NoAnalysisIndexBuilt"),
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Build index"));

    await waitFor(() => {
      expect(trainingClient.buildTrainingAnalysisIndex).toHaveBeenCalledTimes(
        1,
      );
    });
    // The output path proves the panel switched to the built index.
    expect(await screen.findByText("/tmp/analysis-mc")).toBeTruthy();

    // dataSources row.
    expect(
      expectMonoLine("hf:3 feed:2 natural:4 scenarios:1 tests:5 jsonl:6"),
    ).toBeTruthy();
    // readableSamples row (total + per-source).
    expect(
      expectMonoLine(
        "total:210 hf:30 feed:20 natural:40 scenarios:10 tests:50 jsonl:60",
      ),
    ).toBeTruthy();
    // evals / matrices / models counts.
    expect(expectMonoLine("evals:7 matrices:8 models:9")).toBeTruthy();
    // model inventory summary (modelCount from inventory length; no scored stats
    // in the manifest branch → best:none).
    expect(expectMonoLine("models:2 best:none")).toBeTruthy();
    // all tiers covered + tier coverage row.
    expect(
      expectMonoLine("all tiers covered 2b:base/trained/ref/improvement"),
    ).toBeTruthy();
    // benchmarkComparisons row (from artifact payload).
    expect(
      expectMonoLine(
        "2b eliza_harness_action_selection base:0.4 trained:0.5 reference:0.8 improvement:25% vs-ref:-37.5%",
      ),
    ).toBeTruthy();
  });

  it("renders populated coverage from an artifact-aggregation response (parser branch 2)", async () => {
    mockBaselineState();
    trainingClient.buildTrainingAnalysisIndex.mockResolvedValue(
      artifactAggregationIndex,
    );

    render(React.createElement(FineTuningView));

    fireEvent.click(await screen.findByLabelText("Build index"));

    await waitFor(() => {
      expect(trainingClient.buildTrainingAnalysisIndex).toHaveBeenCalledTimes(
        1,
      );
    });
    expect(await screen.findByText("/tmp/analysis-aa")).toBeTruthy();

    // dataSources counted from artifact kinds/schemas (1 each).
    expect(
      expectMonoLine("hf:1 feed:1 natural:1 scenarios:1 tests:1 jsonl:1"),
    ).toBeTruthy();
    // readableSamples summed from the *SamplePreviews arrays (2+1+3+1+1+4 = 12).
    expect(
      expectMonoLine(
        "total:12 hf:2 feed:1 natural:3 scenarios:1 tests:1 jsonl:4",
      ),
    ).toBeTruthy();
    // evals(1)/benchmarkMatrices(1)/models(1) counted by kind.
    expect(expectMonoLine("evals:1 matrices:1 models:1")).toBeTruthy();
    // model inventory summary from modelStats → best model + avg score.
    expect(
      expectMonoLine("models:2 best:eliza-1-2b-trained avg:0.72"),
    ).toBeTruthy();
    // fallback branch reports partial tier coverage (no tier rows).
    expect(expectMonoLine("partial")).toBeTruthy();
    // benchmarkComparisons row.
    expect(
      expectMonoLine(
        "2b eliza_harness_action_selection base:0.4 trained:0.5 reference:0.8 improvement:25% vs-ref:-37.5%",
      ),
    ).toBeTruthy();
  });

  it("keeps the complete empty-state action surface operable", async () => {
    for (const [name, operation] of Object.entries(trainingClient)) {
      if (name !== "onWsEvent" && "mockRejectedValue" in operation) {
        operation.mockRejectedValue(new Error("expected boundary failure"));
      }
    }
    mockBaselineState();

    render(React.createElement(FineTuningView));
    await screen.findByText("finetuningview.Status");

    const actionIds = [
      "action-build-analysis-index",
      "action-build-readiness-report",
      "action-ingest-hf-dataset",
      "action-generate-feed-trajectories",
      "action-run-scenarios",
      "action-run-eval-comparison",
      "action-run-benchmark-vs-cerebras",
      "action-stage-eliza1-bundle",
      "action-run-action-benchmark",
      "action-collection-preflight",
      "action-collect-and-index",
    ];
    for (const actionId of actionIds) {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-agent-id="${actionId}"]`,
      );
      expect(button, `${actionId} should render`).toBeTruthy();
      if (button) fireEvent.click(button);
      await Promise.resolve();
    }

    await waitFor(() => {
      const transportCalls = Object.values(trainingClient).reduce(
        (total, operation) => total + operation.mock.calls.length,
        0,
      );
      expect(transportCalls).toBeGreaterThan(12);
    });
  });
});
