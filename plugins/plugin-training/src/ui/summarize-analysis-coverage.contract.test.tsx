// @vitest-environment jsdom

// Contract test for the VIEW's analysis-coverage parser. The core
// training-analysis-index.test.ts validates the index BUILDER, but nothing pins
// the FineTuningView parser (summarizeAnalysisCoverage / formatModelInventory) to
// the builder's ACTUAL output shape. Here we run the REAL builder
// (buildTrainingAnalysisIndex) over real-shaped artifact files, feed its exact
// output through the rendered view (via client.buildTrainingAnalysisIndex), and
// assert the rendered coverage equals the builder's own manifest.coverage —
// deriving every expected number from the real builder, never hardcoding.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  listTrainingDatasets: vi.fn(),
  listTrainingJobs: vi.fn(),
  listTrainingModels: vi.fn(),
  listTrainingCollections: vi.fn(),
  buildTrainingAnalysisIndex: vi.fn(),
  onWsEvent: vi.fn(() => () => undefined),
}));

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
// root barrel); mock that subpath too or the real store runs and `t` yields
// raw i18n keys instead of resolved labels.
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

// FineTuningView pulls Textarea and the Select family straight from the barrel
// (its own AgentTextAreaField/AgentNativeSelect), so every referenced barrel
// symbol must be present — a missing one makes vitest's mock proxy throw
// "No <name> export" and abort the render before any assertion runs.
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
import {
  BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
  BENCHMARK_MATRIX_ARTIFACT_VERSION,
} from "../core/benchmark-matrix-artifact.js";
import { buildTrainingAnalysisIndex } from "../core/training-analysis-index.js";
import { FineTuningView } from "./FineTuningView";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "view-analysis-contract-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

const baseStatus = {
  runningJobs: 0,
  queuedJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  modelCount: 0,
  datasetCount: 0,
  runtimeAvailable: true,
};

function mockBaselineState() {
  trainingClient.getTrainingStatus.mockResolvedValue(baseStatus);
  trainingClient.listTrainingTrajectories.mockResolvedValue({
    available: true,
    total: 0,
    trajectories: [],
  });
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

// Build a REAL analysis index from real-shaped artifact files (mirroring the
// fixtures the core index test uses) so the view parser is exercised over the
// builder's genuine manifest.coverage shape.
async function buildRealIndex(): Promise<TrainingAnalysisIndexResponse> {
  const root = await makeTempDir();
  const outputDir = join(root, "analysis");

  // Hugging Face dataset ingest (downloaded file + manifest).
  const hfDir = join(root, "hf");
  await writeJsonl(join(hfDir, "sft", "2b", "train.jsonl"), [
    {
      schema: "eliza.eliza1_sft_record.v1",
      source_dataset: "huggingface_sft",
      trajectoryId: "hf-contract-traj-1",
      task: "response",
      input: "hf contract input",
      output: "hf contract output",
    },
  ]);
  await writeJson(join(hfDir, "huggingface-dataset-manifest.json"), {
    schema: "eliza_huggingface_dataset_ingest",
    schemaVersion: 1,
    generatedAt: "2026-01-02T03:35:00.000Z",
    source: {
      kind: "huggingface_dataset",
      repoId: "elizaos/eliza-1-training",
      revision: "main",
    },
    outputDir: hfDir,
    counts: { files: 1, downloadedFiles: 1, dryRunFiles: 0, jsonlRows: 1 },
    files: [
      {
        hfPath: "sft/2b/train.jsonl",
        localPath: join(hfDir, "sft", "2b", "train.jsonl"),
        rows: 1,
        bytes: 128,
        status: "downloaded",
      },
    ],
  });

  // Benchmark matrix artifact (rows + comparisons + model stats).
  await writeJson(join(root, "benchmarks", "matrix", "benchmark-matrix.json"), {
    schema: BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
    version: BENCHMARK_MATRIX_ARTIFACT_VERSION,
    generatedAt: "2026-01-02T03:25:00.000Z",
    source: { kind: "training_benchmark_matrix" },
    referenceModelId: "cerebras/gpt-oss-120b",
    tiers: ["2b"],
    benchmarks: ["eliza_harness_action_selection"],
    counts: { rows: 2, comparisons: 1, tiers: 1, benchmarks: 1 },
    rows: [
      {
        modelId: "eliza-1-2b-base",
        benchmark: "eliza_harness_action_selection",
        score: 0.4,
        variant: "base",
        tier: "2b",
        provider: "local-llama-cpp",
        metrics: { total: 1, passed: 0, failed: 1, useMocks: false },
      },
      {
        modelId: "eliza-1-2b-trained",
        benchmark: "eliza_harness_action_selection",
        score: 0.5,
        variant: "trained",
        tier: "2b",
        provider: "local-llama-cpp",
        metrics: { total: 1, passed: 1, failed: 0, useMocks: false },
      },
    ],
    comparisons: [
      {
        tier: "2b",
        benchmark: "eliza_harness_action_selection",
        baseScore: 0.4,
        trainedScore: 0.5,
        referenceScore: 0.8,
        improvementPercent: 25,
      },
    ],
  });

  // Model registry entry.
  await writeJson(join(root, "models", "2b-model-manifest.json"), {
    schema: "eliza1_model_registry_entry",
    model: "eliza-1-2b-trained",
    variant: "trained",
    tier: "2b",
    outputPath: "hf://elizaos/eliza-1-2b-trained",
    baseModel: "eliza-1-2b-base",
    repoId: "elizaos/eliza-1-2b-trained",
  });

  return (await buildTrainingAnalysisIndex({
    roots: [root],
    outputDir,
    now: () => new Date("2026-01-02T04:00:00.000Z"),
  })) as TrainingAnalysisIndexResponse;
}

function monoLine(expected: string) {
  return screen.getByText((_content, node) => {
    if (node?.tagName !== "DIV") return false;
    return node.textContent?.replace(/\s+/g, " ").trim() === expected;
  });
}

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("FineTuningView coverage parser vs the real index builder", () => {
  it("renders coverage derived from the actual buildTrainingAnalysisIndex output", async () => {
    mockBaselineState();
    const index = await buildRealIndex();
    trainingClient.buildTrainingAnalysisIndex.mockResolvedValue(index);

    // Sanity: the real builder produced a manifest.coverage block (the branch the
    // view's parser consumes). Derive every assertion from it — no magic numbers.
    const coverage = index.manifest.coverage;
    expect(coverage).toBeTruthy();
    const ds = coverage.dataSources;
    const rs = coverage.readableSamples;
    // The builder should have detected exactly the HF source we wrote.
    expect(ds.huggingFace).toBe(1);
    expect(rs.huggingFace).toBe(1);

    render(React.createElement(FineTuningView));

    const statusHeading = await screen.findByText("finetuningview.Status");
    expect(
      statusHeading.parentElement?.nextElementSibling?.className,
    ).toContain("grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))]");

    fireEvent.click(await screen.findByLabelText("Build index"));
    await waitFor(() => {
      expect(trainingClient.buildTrainingAnalysisIndex).toHaveBeenCalledTimes(
        1,
      );
    });
    expect(await screen.findByText(index.outputDir)).toBeTruthy();

    // dataSources row matches the builder exactly.
    expect(
      monoLine(
        `hf:${ds.huggingFace} feed:${ds.feed} natural:${ds.natural} scenarios:${ds.scenarios} tests:${ds.tests} jsonl:${ds.trainingJsonl}`,
      ),
    ).toBeTruthy();
    // readableSamples row matches.
    expect(
      monoLine(
        `total:${rs.total} hf:${rs.huggingFace} feed:${rs.feed} natural:${rs.natural} scenarios:${rs.scenarios} tests:${rs.tests} jsonl:${rs.trainingJsonl}`,
      ),
    ).toBeTruthy();
    // evals / matrices / models counts match.
    expect(
      monoLine(
        `evals:${coverage.evals.artifacts} matrices:${coverage.benchmarks.matrices} models:${coverage.models.artifacts}`,
      ),
    ).toBeTruthy();
    // model inventory summary: count from the builder's models.inventory length.
    expect(
      monoLine(`models:${coverage.models.inventory.length} best:none`),
    ).toBeTruthy();

    // Benchmark comparison row: parsed from the benchmark_matrix artifact payload.
    const comparison = index.manifest.artifacts
      .filter((artifact) => artifact.kind === "benchmark_matrix")
      .flatMap(
        (artifact) =>
          (artifact.payload as { comparisons?: unknown[] }).comparisons ?? [],
      )[0] as {
      tier: string;
      benchmark: string;
      baseScore: number;
      trainedScore: number;
      referenceScore: number;
      improvementPercent: number;
    };
    expect(comparison).toBeTruthy();
    expect(
      monoLine(
        `${comparison.tier} ${comparison.benchmark} base:${comparison.baseScore} trained:${comparison.trainedScore} reference:${comparison.referenceScore} improvement:${comparison.improvementPercent}% vs-ref:n/a%`,
      ),
    ).toBeTruthy();

    // Tier coverage: the builder marks tiers; render reflects allEliza1TiersCovered.
    if (coverage.benchmarks.allEliza1TiersCovered) {
      expect(screen.getByText(/all tiers covered/)).toBeTruthy();
    } else {
      const tierRow = coverage.benchmarks.tierCoverage
        .map(
          (tier) =>
            `${tier.tier}:${tier.hasBase ? "base" : "-"}/${
              tier.hasTrained ? "trained" : "-"
            }/${tier.hasReference ? "ref" : "-"}/${
              tier.hasImprovement ? "improvement" : "-"
            }`,
        )
        .join(" ");
      expect(monoLine(`partial ${tierRow}`.trim())).toBeTruthy();
    }
  });
});
