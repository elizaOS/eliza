import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import {
  applyPrivacyFilter,
  type FilterableTrajectory,
  type FilterResult,
  type PrivacyFilterOptions,
} from "./privacy-filter.js";
import {
  type HfUploadConfig,
  resolveHfUploadConfig,
  uploadTrajectoryJsonlToHuggingFace,
} from "./trajectory-hf-upload.js";
import {
  exportTrajectoryTaskDatasets,
  type ElizaNativeTrainingExample,
  type TrajectoryTaskDatasetExport,
  type TrajectoryTrainingTask,
} from "./trajectory-task-datasets.js";

export const TRAJECTORY_EXPORT_BUNDLE_SCHEMA = "eliza_trajectory_export_bundle";
export const TRAJECTORY_EXPORT_BUNDLE_VERSION = 1;

type ExportableTrajectory = Trajectory & FilterableTrajectory;

export interface TrajectoryExportBundleSource {
  kind: string;
  runId?: string;
  runIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface TrajectoryExportBundlePrivacyStats {
  applied: boolean;
  redactionCount: number | null;
  anonymizationCount: number | null;
  droppedCount: number;
  dropped: Array<{ trajectoryId?: string; reason: string }>;
}

export interface TrajectoryExportBundleTaskFile {
  path: string;
  exampleCount: number;
  sourceCallCount: number;
  sourceTrajectoryCount: number;
}

export interface TrajectoryExportBundleCloudUpload {
  uploadedToHuggingFace: boolean;
  huggingFaceRepo?: string;
  huggingFacePath?: string;
  huggingFaceError?: string;
}

export interface TrajectoryExportBundleManifest {
  schema: typeof TRAJECTORY_EXPORT_BUNDLE_SCHEMA;
  schemaVersion: typeof TRAJECTORY_EXPORT_BUNDLE_VERSION;
  generatedAt: string;
  runId: string | null;
  source: TrajectoryExportBundleSource & {
    inputTrajectoryCount: number;
    sanitizedTrajectoryCount: number;
    droppedTrajectoryCount: number;
  };
  paths: {
    bundleDir: string;
    manifestPath: string;
    viewerHtmlPath?: string;
    rawJsonlPath?: string;
    sanitizedJsonlPath?: string;
    taskDatasetDir?: string;
    taskDatasetSummaryPath?: string;
  };
  counts: {
    rawTrajectoryRows: number;
    sanitizedTrajectoryRows: number;
    taskRows: Record<TrajectoryTrainingTask, number>;
    taskFiles: number;
    taskExamples: number;
    llmCalls: number | null;
    skippedNonNativeRows: number | null;
  };
  tasks: Partial<
    Record<TrajectoryTrainingTask, TrajectoryExportBundleTaskFile>
  >;
  privacy: TrajectoryExportBundlePrivacyStats;
  cloudUpload: TrajectoryExportBundleCloudUpload;
}

export interface TrajectoryExportBundle {
  outputDir: string;
  manifestPath: string;
  manifest: TrajectoryExportBundleManifest;
}

export interface BuildTrajectoryExportBundleOptions {
  outputDir: string;
  trajectories?: Trajectory[];
  sanitizedTrajectories?: Trajectory[];
  rawJsonlPath?: string;
  sanitizedJsonlPath?: string;
  includeRawJsonl?: boolean;
  tasks?: readonly TrajectoryTrainingTask[];
  source?: TrajectoryExportBundleSource;
  privacy?: {
    apply?: boolean;
    options?: PrivacyFilterOptions;
    stats?: TrajectoryExportBundlePrivacyStats;
  };
  /**
   * Upload the sanitized JSONL to a HuggingFace dataset repo. `true` resolves
   * the config from the environment (`ELIZA_TRAJECTORY_HF_REPO` + HF token);
   * pass an explicit `HfUploadConfig` to override. Defaults to no upload.
   */
  uploadToHuggingFace?: boolean | HfUploadConfig;
  now?: () => Date;
}

function taskPathMap(
  paths: TrajectoryTaskDatasetExport["paths"],
): Record<TrajectoryTrainingTask, string> {
  return {
    should_respond: paths.shouldRespondPath,
    context_routing: paths.contextRoutingPath,
    action_planner: paths.actionPlannerPath,
    response: paths.responsePath,
    media_description: paths.mediaDescriptionPath,
  };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function jsonl(rows: readonly unknown[]): string {
  if (rows.length === 0) return "";
  return `${rows.map(stableJson).join("\n")}\n`;
}

function countJsonlRows(payload: string): number {
  return payload
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function parseJsonlRows(text: string | null): unknown[] {
  if (!text) return [];
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      rows.push({ parseError: true, line: trimmed });
    }
  }
  return rows;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildViewerHtml(input: {
  manifest: TrajectoryExportBundleManifest;
  sanitizedTrajectories: unknown[];
  taskExamples: Record<TrajectoryTrainingTask, ElizaNativeTrainingExample[]>;
}): string {
  const data = {
    manifest: input.manifest,
    sanitizedTrajectories: input.sanitizedTrajectories,
    taskExamples: input.taskExamples,
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Eliza Trajectory Export Viewer</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f4ee;
      --ink: #161514;
      --muted: #69635a;
      --line: #d8d0c4;
      --panel: #fffdfa;
      --accent: #b7431f;
      --accent-ink: #fff7f2;
      --code: #22201d;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #161514;
        --ink: #f5efe6;
        --muted: #bdb3a5;
        --line: #3a352f;
        --panel: #201e1b;
        --accent: #e66d37;
        --accent-ink: #21120b;
        --code: #f8efe3;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    header {
      border-bottom: 1px solid var(--line);
      padding: 24px clamp(16px, 4vw, 48px) 18px;
    }
    h1 {
      font-size: clamp(24px, 4vw, 42px);
      margin: 0 0 8px;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      display: flex;
      flex-wrap: wrap;
      gap: 10px 18px;
      font-size: 14px;
    }
    main {
      padding: 18px clamp(16px, 4vw, 48px) 48px;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      border-radius: 6px;
      padding: 9px 12px;
      cursor: pointer;
      font: inherit;
    }
    button[aria-selected="true"] {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-ink);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .metric, .row {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .metric strong {
      display: block;
      font-size: 24px;
    }
    .metric span, .label {
      color: var(--muted);
      font-size: 13px;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(220px, 320px) 1fr;
      gap: 14px;
      align-items: start;
    }
    .list {
      display: grid;
      gap: 8px;
      max-height: 70vh;
      overflow: auto;
    }
    .row {
      text-align: left;
      width: 100%;
    }
    .row.active {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--code);
      padding: 14px;
      max-height: 76vh;
      overflow: auto;
      font-size: 12px;
    }
    .hidden { display: none; }
    @media (max-width: 760px) {
      .split { grid-template-columns: 1fr; }
      pre { max-height: none; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Eliza Trajectory Export</h1>
    <div class="meta">
      <span>Generated ${escapeHtml(input.manifest.generatedAt)}</span>
      <span>Source ${escapeHtml(input.manifest.source.kind)}</span>
      <span>Run ${escapeHtml(input.manifest.runId ?? "mixed")}</span>
      <span>${input.manifest.counts.sanitizedTrajectoryRows} sanitized trajectories</span>
      <span>${input.manifest.counts.taskExamples} task examples</span>
    </div>
  </header>
  <main>
    <nav class="tabs" aria-label="Viewer sections">
      <button type="button" data-tab="overview" aria-selected="true">Overview</button>
      <button type="button" data-tab="trajectories" aria-selected="false">Trajectories</button>
      <button type="button" data-tab="tasks" aria-selected="false">Task Datasets</button>
      <button type="button" data-tab="manifest" aria-selected="false">Manifest</button>
    </nav>
    <section id="overview"></section>
    <section id="trajectories" class="hidden"></section>
    <section id="tasks" class="hidden"></section>
    <section id="manifest" class="hidden"></section>
  </main>
  <script type="application/json" id="viewer-data">${escapeScriptJson(data)}</script>
  <script>
    const data = JSON.parse(document.getElementById("viewer-data").textContent);
    const tasks = ["should_respond", "context_routing", "action_planner", "response", "media_description"];
    const pretty = (value) => JSON.stringify(value, null, 2);
    const metric = (label, value) => '<div class="metric"><strong>' + value + '</strong><span>' + label + '</span></div>';
    function renderOverview() {
      const m = data.manifest;
      const target = document.getElementById("overview");
      target.innerHTML =
        '<div class="grid">' +
        metric("Input trajectories", m.source.inputTrajectoryCount) +
        metric("Sanitized trajectories", m.source.sanitizedTrajectoryCount) +
        metric("Dropped trajectories", m.source.droppedTrajectoryCount) +
        metric("LLM calls", m.counts.llmCalls ?? "n/a") +
        metric("Task files", m.counts.taskFiles) +
        metric("Task examples", m.counts.taskExamples) +
        '</div><pre></pre>';
      target.querySelector("pre").textContent = pretty({
          paths: m.paths,
          taskRows: m.counts.taskRows,
          privacy: m.privacy,
          cloudUpload: m.cloudUpload
        });
    }
    function renderSelectable(targetId, rows, labelFor) {
      const target = document.getElementById(targetId);
      if (rows.length === 0) {
        target.innerHTML = '<pre>No rows were exported for this section.</pre>';
        return;
      }
      target.innerHTML = '<div class="split"><div class="list"></div><pre></pre></div>';
      const list = target.querySelector(".list");
      const detail = target.querySelector("pre");
      rows.forEach((row, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "row" + (index === 0 ? " active" : "");
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = String(index + 1);
        const title = document.createElement("strong");
        title.textContent = String(labelFor(row, index));
        button.append(label, title);
        button.addEventListener("click", () => {
          for (const item of list.querySelectorAll(".row")) item.classList.remove("active");
          button.classList.add("active");
          detail.textContent = pretty(row);
        });
        list.appendChild(button);
      });
      detail.textContent = pretty(rows[0]);
    }
    function renderTrajectories() {
      renderSelectable("trajectories", data.sanitizedTrajectories, (row, index) =>
        row.trajectoryId || row.id || row.callId || "trajectory-" + (index + 1)
      );
    }
    function renderTasks() {
      const rows = tasks.flatMap((task) => (data.taskExamples[task] || []).map((example) => ({ task, example })));
      renderSelectable("tasks", rows, (row, index) =>
        row.task + " / " + (row.example.trajectoryId || row.example.callId || index + 1)
      );
    }
    function renderManifest() {
      const target = document.getElementById("manifest");
      target.innerHTML = '<pre></pre>';
      target.querySelector("pre").textContent = pretty(data.manifest);
    }
    renderOverview();
    renderTrajectories();
    renderTasks();
    renderManifest();
    for (const button of document.querySelectorAll("[data-tab]")) {
      button.addEventListener("click", () => {
        const selected = button.dataset.tab;
        for (const tab of document.querySelectorAll("[data-tab]")) {
          tab.setAttribute("aria-selected", String(tab === button));
        }
        for (const section of document.querySelectorAll("main > section")) {
          section.classList.toggle("hidden", section.id !== selected);
        }
      });
    }
  </script>
</body>
</html>
`;
}

function normalizePrivacyStats(
  privacyResult: FilterResult<ExportableTrajectory> | null,
  explicitStats: TrajectoryExportBundlePrivacyStats | undefined,
  applied: boolean,
): TrajectoryExportBundlePrivacyStats {
  if (explicitStats) {
    return explicitStats;
  }
  if (privacyResult) {
    return {
      applied: true,
      redactionCount: privacyResult.redactionCount,
      anonymizationCount: privacyResult.anonymizationCount,
      droppedCount: privacyResult.dropped.length,
      dropped: privacyResult.dropped,
    };
  }
  return {
    applied,
    redactionCount: null,
    anonymizationCount: null,
    droppedCount: 0,
    dropped: [],
  };
}

function buildTaskFiles(
  dataset: TrajectoryTaskDatasetExport | null,
): Partial<Record<TrajectoryTrainingTask, TrajectoryExportBundleTaskFile>> {
  if (!dataset) return {};
  const pathsByTask = taskPathMap(dataset.paths);
  const tasks: Partial<
    Record<TrajectoryTrainingTask, TrajectoryExportBundleTaskFile>
  > = {};
  for (const task of dataset.summary.tasks) {
    const metrics = dataset.summary.taskMetrics[task];
    tasks[task] = {
      path: pathsByTask[task],
      exampleCount: metrics.exampleCount,
      sourceCallCount: metrics.sourceCallCount,
      sourceTrajectoryCount: metrics.sourceTrajectoryCount,
    };
  }
  return tasks;
}

function emptyTaskCounts(): Record<TrajectoryTrainingTask, number> {
  return {
    should_respond: 0,
    context_routing: 0,
    action_planner: 0,
    response: 0,
    media_description: 0,
  };
}

function emptyTaskExamples(): Record<
  TrajectoryTrainingTask,
  ElizaNativeTrainingExample[]
> {
  return {
    should_respond: [],
    context_routing: [],
    action_planner: [],
    response: [],
    media_description: [],
  };
}

function normalizeRunId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function addRunId(runIds: Set<string>, value: unknown): void {
  const runId = normalizeRunId(value);
  if (runId) runIds.add(runId);
}

function collectTrajectoryRunIds(
  trajectories: readonly Trajectory[],
): string[] {
  const runIds = new Set<string>();
  for (const trajectory of trajectories) {
    const record = trajectory as Trajectory & {
      runId?: unknown;
      metadata?: Record<string, unknown>;
    };
    addRunId(runIds, record.runId);
    addRunId(runIds, record.metadata?.runId);
    addRunId(runIds, record.metadata?.appRunId);

    for (const step of trajectory.steps ?? []) {
      for (const call of step.llmCalls ?? []) {
        addRunId(runIds, call.runId);
      }
      for (const access of step.providerAccesses ?? []) {
        addRunId(runIds, access.runId);
      }
    }
  }
  return [...runIds].sort();
}

function resolveBundleRunIds(
  source: TrajectoryExportBundleSource | undefined,
  trajectories: readonly Trajectory[],
): { runId: string | null; runIds: string[] } {
  const runIds = new Set<string>(collectTrajectoryRunIds(trajectories));
  addRunId(runIds, source?.runId);
  for (const runId of source?.runIds ?? []) {
    addRunId(runIds, runId);
  }

  const sorted = [...runIds].sort();
  const explicitRunId = normalizeRunId(source?.runId);
  return {
    runId: explicitRunId ?? (sorted.length === 1 ? sorted[0] : null),
    runIds: sorted,
  };
}

export async function buildTrajectoryExportBundle(
  options: BuildTrajectoryExportBundleOptions,
): Promise<TrajectoryExportBundle> {
  await mkdir(options.outputDir, { recursive: true });

  const inputTrajectories = options.trajectories ?? [];
  const exportableTrajectories = inputTrajectories as ExportableTrajectory[];
  const hasPreSanitizedInput =
    options.sanitizedTrajectories !== undefined ||
    options.sanitizedJsonlPath !== undefined;
  const shouldApplyPrivacy = options.privacy?.apply ?? !hasPreSanitizedInput;
  const privacyResult =
    shouldApplyPrivacy && exportableTrajectories.length > 0
      ? applyPrivacyFilter(exportableTrajectories, options.privacy?.options)
      : null;
  const sanitizedTrajectories =
    options.sanitizedTrajectories ??
    (privacyResult?.trajectories as Trajectory[] | undefined) ??
    [];
  const privacy = normalizePrivacyStats(
    privacyResult,
    options.privacy?.stats,
    shouldApplyPrivacy,
  );

  let rawTrajectoryRows = 0;
  let rawJsonlPath: string | undefined;
  if (options.includeRawJsonl) {
    await mkdir(join(options.outputDir, "raw"), { recursive: true });
    rawJsonlPath = join(options.outputDir, "raw", "trajectories.raw.jsonl");
    if (options.rawJsonlPath) {
      await copyFile(options.rawJsonlPath, rawJsonlPath);
      rawTrajectoryRows = countJsonlRows(await readFile(rawJsonlPath, "utf8"));
    } else {
      await writeFile(rawJsonlPath, jsonl(inputTrajectories));
      rawTrajectoryRows = inputTrajectories.length;
    }
  }

  let sanitizedTrajectoryRows = sanitizedTrajectories.length;
  let sanitizedJsonlPath: string | undefined;
  let sanitizedJsonlText: string | null = null;
  if (options.sanitizedJsonlPath) {
    await mkdir(join(options.outputDir, "sanitized"), { recursive: true });
    sanitizedJsonlPath = join(
      options.outputDir,
      "sanitized",
      "trajectories.sanitized.jsonl",
    );
    await copyFile(options.sanitizedJsonlPath, sanitizedJsonlPath);
    sanitizedJsonlText = await readFile(sanitizedJsonlPath, "utf8");
    sanitizedTrajectoryRows = countJsonlRows(sanitizedJsonlText);
  } else if (sanitizedTrajectories.length > 0 || inputTrajectories.length > 0) {
    await mkdir(join(options.outputDir, "sanitized"), { recursive: true });
    sanitizedJsonlPath = join(
      options.outputDir,
      "sanitized",
      "trajectories.sanitized.jsonl",
    );
    sanitizedJsonlText = jsonl(sanitizedTrajectories);
    await writeFile(sanitizedJsonlPath, sanitizedJsonlText);
  }

  // Upload the sanitized JSONL to HuggingFace when requested. The privacy
  // filter has already run above — this only ever touches the sanitized file.
  let cloudUpload: TrajectoryExportBundleCloudUpload = {
    uploadedToHuggingFace: false,
  };
  if (options.uploadToHuggingFace && sanitizedJsonlPath) {
    const uploadConfig =
      options.uploadToHuggingFace === true
        ? resolveHfUploadConfig()
        : options.uploadToHuggingFace;
    if (uploadConfig) {
      const pathInRepo = `trajectories/${(options.now?.() ?? new Date())
        .toISOString()
        .replace(/[:.]/g, "-")}.jsonl`;
      const uploadResult = await uploadTrajectoryJsonlToHuggingFace(
        sanitizedJsonlPath,
        pathInRepo,
        uploadConfig,
      );
      cloudUpload = {
        uploadedToHuggingFace: uploadResult.uploaded,
        huggingFaceRepo: uploadResult.repo ?? undefined,
        huggingFacePath: uploadResult.pathInRepo ?? undefined,
        huggingFaceError: uploadResult.error ?? undefined,
      };
    } else {
      cloudUpload = {
        uploadedToHuggingFace: false,
        huggingFaceError:
          "HuggingFace upload requested but not configured (set ELIZA_TRAJECTORY_HF_REPO and an HF token)",
      };
    }
  }

  let taskDataset: TrajectoryTaskDatasetExport | null = null;
  if (sanitizedJsonlText !== null || sanitizedTrajectories.length > 0) {
    const taskDatasetDir = join(options.outputDir, "tasks");
    taskDataset = await exportTrajectoryTaskDatasets(
      sanitizedJsonlText !== null && options.sanitizedJsonlPath
        ? sanitizedJsonlText
        : sanitizedTrajectories,
      taskDatasetDir,
      options.tasks,
    );
  }

  const taskFiles = buildTaskFiles(taskDataset);
  const taskExamples = Object.values(taskFiles).reduce(
    (sum, task) => sum + task.exampleCount,
    0,
  );
  const taskCounts = taskDataset?.counts ?? emptyTaskCounts();
  const manifestPath = join(options.outputDir, "manifest.json");
  const viewerHtmlPath = join(options.outputDir, "index.html");
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const runLineage = resolveBundleRunIds(options.source, [
    ...inputTrajectories,
    ...sanitizedTrajectories,
  ]);
  const manifest: TrajectoryExportBundleManifest = {
    schema: TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
    schemaVersion: TRAJECTORY_EXPORT_BUNDLE_VERSION,
    generatedAt,
    runId: runLineage.runId,
    source: {
      kind: options.source?.kind ?? "trajectory-export-bundle",
      runId: runLineage.runId ?? undefined,
      runIds: runLineage.runIds,
      inputTrajectoryCount: inputTrajectories.length || rawTrajectoryRows,
      sanitizedTrajectoryCount: sanitizedTrajectoryRows,
      droppedTrajectoryCount: privacy.droppedCount,
      metadata: options.source?.metadata
        ? (sortJsonValue(options.source.metadata) as Record<string, unknown>)
        : undefined,
    },
    paths: {
      bundleDir: options.outputDir,
      manifestPath,
      viewerHtmlPath,
      rawJsonlPath,
      sanitizedJsonlPath,
      taskDatasetDir: taskDataset
        ? join(options.outputDir, "tasks")
        : undefined,
      taskDatasetSummaryPath: taskDataset?.paths.summaryPath,
    },
    counts: {
      rawTrajectoryRows,
      sanitizedTrajectoryRows,
      taskRows: taskCounts,
      taskFiles: Object.keys(taskFiles).length,
      taskExamples,
      llmCalls: taskDataset?.summary.llmCallCount ?? null,
      skippedNonNativeRows: taskDataset?.summary.skippedNonNativeRows ?? null,
    },
    tasks: taskFiles,
    privacy,
    cloudUpload,
  };

  await writeFile(
    viewerHtmlPath,
    buildViewerHtml({
      manifest,
      sanitizedTrajectories:
        sanitizedJsonlText !== null
          ? parseJsonlRows(sanitizedJsonlText)
          : sanitizedTrajectories,
      taskExamples: taskDataset?.examples ?? emptyTaskExamples(),
    }),
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    outputDir: options.outputDir,
    manifestPath,
    manifest,
  };
}
