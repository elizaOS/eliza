/**
 * Presentational panel components for the fine-tuning dashboard (status,
 * datasets, jobs, models, backends, and controls), consumed by FineTuningView.
 * Non-component constants and the streamed-event parser live in
 * `fine-tuning-panels.helpers.ts` to keep this file Fast-Refresh-compatible.
 */
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type {
  TrainingDatasetRecord,
  TrainingJobRecord,
  TrainingModelRecord,
  TrainingStreamEvent,
  TrainingTrajectoryDetail,
  TrainingTrajectoryList,
} from "@elizaos/ui/api";
import { Button, Input } from "@elizaos/ui/components";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@elizaos/ui/components/ui/select";
import { SettingsControls } from "@elizaos/ui/components/ui/settings-controls";
import { formatTime } from "@elizaos/ui/utils";
import { memo, type ReactNode } from "react";
import {
  FINE_TUNING_ACTION_CLASS,
  FINE_TUNING_SECTION_HEADER_CLASS,
  formatDate,
  formatProgress,
  summarizeAvailability,
  type TranslateFn,
} from "./fine-tuning-panels.helpers";

/* Flat — no card/border. The shell owns the page's horizontal padding;
 * sections separate by whitespace + type scale, panels by grid gaps. */
const FINE_TUNING_SECTION_CLASS = "";
const FINE_TUNING_PANEL_CLASS = "";

const FILTER_INPUT_CLASS = "h-11 text-sm text-txt";

/* ── Agent-surface helpers ─────────────────────────────────────────── */

function AgentActionButton({
  agentId,
  label,
  group,
  description,
  variant = "outline",
  size = "sm",
  className,
  disabled,
  onClick,
  children,
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  variant?: "outline" | "ghost" | "link";
  size?: "sm";
  className: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group,
    description,
    onActivate: onClick,
  });
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      className={className}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      {...agentProps}
    >
      {children}
    </Button>
  );
}

function AgentTextInput({
  agentId,
  label,
  group,
  description,
  value,
  onChange,
  placeholder,
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: "text-input",
    label,
    group,
    description,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <Input
      ref={ref}
      className={FILTER_INPUT_CLASS}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      {...agentProps}
    />
  );
}

function AgentSelect({
  agentId,
  label,
  group,
  description,
  value,
  onValueChange,
  options,
  placeholder,
  children,
}: {
  agentId: string;
  label: string;
  group: string;
  description: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly string[];
  placeholder?: string;
  children: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "select",
    label,
    group,
    description,
    options,
    getValue: () => value,
    onFill: (next) => onValueChange(next),
  });
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SettingsControls.SelectTrigger
        ref={ref}
        variant="toolbar"
        aria-label={label}
        {...agentProps}
      >
        <SelectValue placeholder={placeholder} />
      </SettingsControls.SelectTrigger>
      {children}
    </Select>
  );
}

type TrajectorySummary = TrainingTrajectoryList["trajectories"][number];

const TrajectoryListItem = memo(function TrajectoryListItem({
  trajectory,
  onSelectTrajectory,
  t,
}: {
  trajectory: TrajectorySummary;
  onSelectTrajectory: (trajectoryId: string) => void;
  t: TranslateFn;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `trajectory-item-${trajectory.trajectoryId}`,
    role: "list-item",
    label: `Trajectory ${trajectory.trajectoryId}`,
    group: "trajectory-list",
    description: "Inspect this trajectory",
    onActivate: () => onSelectTrajectory(trajectory.trajectoryId),
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      className="w-full justify-start rounded-none px-3 py-3 text-left text-xs hover:bg-bg-hover"
      onClick={() => onSelectTrajectory(trajectory.trajectoryId)}
      {...agentProps}
    >
      <div className="font-mono">{trajectory.trajectoryId}</div>
      <div className="text-muted mt-1">
        {t("finetuningview.Calls")} {trajectory.llmCallCount}{" "}
        {t("finetuningview.Reward")} {trajectory.totalReward ?? "n/a"} ·{" "}
        {formatDate(trajectory.createdAt)}
      </div>
    </Button>
  );
});

const DatasetRadioItem = memo(function DatasetRadioItem({
  dataset,
  selectedDatasetId,
  setSelectedDatasetId,
  t,
}: {
  dataset: TrainingDatasetRecord;
  selectedDatasetId: string;
  setSelectedDatasetId: (value: string) => void;
  t: TranslateFn;
}) {
  const checked = selectedDatasetId === dataset.id;
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: `dataset-select-${dataset.id}`,
    role: "list-item",
    label: `Select dataset ${dataset.id}`,
    group: "dataset-list",
    description: "Choose this dataset for training",
    status: checked ? "active" : "inactive",
    onActivate: () => setSelectedDatasetId(dataset.id),
  });
  const inputId = `dataset-select-input-${dataset.id.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  )}`;
  return (
    <label
      htmlFor={inputId}
      className="flex min-h-touch cursor-pointer items-center gap-3 px-3 py-3 text-sm transition-colors hover:bg-bg/35"
    >
      <Input
        id={inputId}
        ref={ref}
        type="radio"
        name="dataset-select"
        checked={checked}
        onChange={() => setSelectedDatasetId(dataset.id)}
        aria-current={checked ? "true" : undefined}
        className="h-4 w-4 p-0"
        {...agentProps}
      />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm text-txt">{dataset.id}</div>
        <div className="mt-1 text-xs text-muted">
          {dataset.sampleCount} {t("finetuningview.samples")}{" "}
          {dataset.trajectoryCount} {t("finetuningview.trajectories")}
        </div>
      </div>
    </label>
  );
});

const JobListItem = memo(function JobListItem({
  job,
  selectedJobId,
  setSelectedJobId,
  cancellingJobId,
  onCancelJob,
  t,
}: {
  job: TrainingJobRecord;
  selectedJobId: string;
  setSelectedJobId: (value: string) => void;
  cancellingJobId: string;
  onCancelJob: (jobId: string) => void;
  t: TranslateFn;
}) {
  const { ref: selectRef, agentProps: selectProps } =
    useAgentElement<HTMLButtonElement>({
      id: `job-item-${job.id}`,
      role: "list-item",
      label: `Select job ${job.id}`,
      group: "job-list",
      description: "Inspect this training job's logs",
      status: selectedJobId === job.id ? "active" : "inactive",
      onActivate: () => setSelectedJobId(job.id),
    });
  const cancellable = job.status === "running" || job.status === "queued";
  const { ref: cancelRef, agentProps: cancelProps } =
    useAgentElement<HTMLButtonElement>({
      id: `job-cancel-${job.id}`,
      role: "button",
      label: `Cancel job ${job.id}`,
      group: "job-list",
      description: "Cancel this training job",
      onActivate: () => onCancelJob(job.id),
    });
  return (
    <div
      className={`px-3 py-3 text-sm ${
        selectedJobId === job.id ? "bg-bg-hover" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <Button
          ref={selectRef}
          variant="link"
          className="h-auto w-auto justify-start p-0 text-left font-mono text-sm"
          onClick={() => setSelectedJobId(job.id)}
          {...selectProps}
        >
          {job.id}
        </Button>
        {cancellable && (
          <Button
            ref={cancelRef}
            variant="outline"
            size="sm"
            className="h-8 rounded-xl border-danger/35 px-3 text-xs-tight text-danger shadow-sm hover:border-danger hover:bg-danger/10 disabled:opacity-50"
            disabled={cancellingJobId === job.id}
            onClick={() => onCancelJob(job.id)}
            {...cancelProps}
          >
            {cancellingJobId === job.id
              ? t("finetuningview.Cancelling")
              : t("finetuningview.Cancel")}
          </Button>
        )}
      </div>
      <div className="mt-1 text-xs text-muted">
        {job.status} · {formatProgress(job.progress)} · {job.phase}
      </div>
      <div className="text-xs text-muted">{formatDate(job.createdAt)}</div>
    </div>
  );
});

const ModelListItem = memo(function ModelListItem({
  model,
  selectedModelId,
  setSelectedModelId,
  t,
}: {
  model: TrainingModelRecord;
  selectedModelId: string;
  setSelectedModelId: (value: string) => void;
  t: TranslateFn;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `model-item-${model.id}`,
    role: "list-item",
    label: `Select model ${model.id}`,
    group: "model-list",
    description: "Choose this trained model for actions",
    status: selectedModelId === model.id ? "active" : "inactive",
    onActivate: () => setSelectedModelId(model.id),
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      className={`w-full justify-start rounded-none px-3 py-3 text-left text-sm ${
        selectedModelId === model.id ? "bg-bg-hover" : "hover:bg-bg-hover"
      }`}
      onClick={() => setSelectedModelId(model.id)}
      {...agentProps}
    >
      <div className="font-mono">
        {model.id} {model.active ? t("finetuningview.ActiveIndicator") : ""}
      </div>
      <div className="mt-1 text-xs text-muted">
        {t("finetuningview.backend")} {model.backend}
        {model.ollamaModel ? ` · ollama: ${model.ollamaModel}` : ""}
      </div>
      <div className="text-xs text-muted">
        {t("finetuningview.benchmark")} {model.benchmark.status}
        {model.benchmark.lastRunAt
          ? ` · ${formatDate(model.benchmark.lastRunAt)}`
          : ""}
      </div>
    </Button>
  );
});

/* ── Trajectories Section ──────────────────────────────────────────── */

export function TrajectoriesSection({
  trajectoryList,
  selectedTrajectory,
  trajectoryLoading,
  publishingTrajectories,
  publishConfigured,
  onRefresh,
  onSelectTrajectory,
  onPublishTrajectories,
  t,
}: {
  trajectoryList: TrainingTrajectoryList;
  selectedTrajectory: TrainingTrajectoryDetail | null;
  trajectoryLoading: boolean;
  publishingTrajectories: boolean;
  publishConfigured: boolean;
  onRefresh: () => void;
  onSelectTrajectory: (trajectoryId: string) => void;
  onPublishTrajectories: () => void;
  t: TranslateFn;
}) {
  return (
    <section className={FINE_TUNING_SECTION_CLASS}>
      <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
        <div className="text-lg font-semibold text-txt">
          {t("finetuningview.Trajectories")}
        </div>
        <div className="flex items-center gap-2">
          <AgentActionButton
            agentId="trajectories-publish"
            label="Publish trajectories to HuggingFace"
            group="trajectories"
            description="Publish collected trajectories to HuggingFace"
            className={FINE_TUNING_ACTION_CLASS}
            disabled={publishingTrajectories || !publishConfigured}
            onClick={onPublishTrajectories}
          >
            {publishingTrajectories
              ? t("finetuningview.Publishing")
              : t("finetuningview.PublishToHuggingFace")}
          </AgentActionButton>
          <AgentActionButton
            agentId="trajectories-refresh"
            label="Refresh trajectories"
            group="trajectories"
            description="Reload the trajectory list"
            className={FINE_TUNING_ACTION_CLASS}
            onClick={onRefresh}
          >
            {t("common.refresh")}
          </AgentActionButton>
        </div>
      </div>
      {!trajectoryList.available ? (
        <div
          className={`${FINE_TUNING_PANEL_CLASS} px-4 py-4 text-sm text-muted`}
        >
          {summarizeAvailability(trajectoryList.reason, t)}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-muted">
            {trajectoryList.total} {t("finetuningview.trajectoryRowsAvai")}
          </div>
          <div className="grid grid-cols-1 gap-3">
            <div className={FINE_TUNING_PANEL_CLASS}>
              <div className="max-h-64 overflow-auto">
                {trajectoryList.trajectories.length === 0 ? (
                  <div className="p-3 text-xs text-muted">
                    {t("finetuningview.NoTrajectoriesFoun")}
                  </div>
                ) : (
                  trajectoryList.trajectories.map(
                    (trajectory: TrajectorySummary) => (
                      <TrajectoryListItem
                        key={trajectory.trajectoryId}
                        trajectory={trajectory}
                        onSelectTrajectory={onSelectTrajectory}
                        t={t}
                      />
                    ),
                  )
                )}
              </div>
            </div>
            <div className={`${FINE_TUNING_PANEL_CLASS} p-3`}>
              {trajectoryLoading ? (
                <div className="text-xs text-muted">
                  {t("finetuningview.LoadingTrajectoryD")}
                </div>
              ) : !selectedTrajectory ? (
                <div className="text-xs text-muted">
                  {t("finetuningview.ChooseATrajectory")}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs">
                    <span className="font-semibold">
                      {t("finetuningview.Trajectory")}
                    </span>{" "}
                    <span className="font-mono">
                      {selectedTrajectory.trajectoryId}
                    </span>
                  </div>
                  <div className="text-xs">
                    <span className="font-semibold">
                      {t("finetuningview.Agent")}
                    </span>{" "}
                    <span className="font-mono">
                      {selectedTrajectory.agentId}
                    </span>
                  </div>
                  <div className="text-xs">
                    <span className="font-semibold">
                      {t("finetuningview.Reward1")}
                    </span>{" "}
                    {selectedTrajectory.totalReward ?? "n/a"}
                  </div>
                  <SettingsControls.Textarea
                    readOnly
                    value={selectedTrajectory.stepsJson}
                    className="max-h-72 min-h-40 overflow-auto font-mono text-xs"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ── Dataset Section ───────────────────────────────────────────────── */

export const DatasetSection = memo(function DatasetSection({
  buildLimit,
  setBuildLimit,
  buildMinCalls,
  setBuildMinCalls,
  datasetBuilding,
  datasets,
  selectedDatasetId,
  setSelectedDatasetId,
  onBuildDataset,
  onRefreshDatasets,
  t,
}: {
  buildLimit: string;
  setBuildLimit: (value: string) => void;
  buildMinCalls: string;
  setBuildMinCalls: (value: string) => void;
  datasetBuilding: boolean;
  datasets: TrainingDatasetRecord[];
  selectedDatasetId: string;
  setSelectedDatasetId: (value: string) => void;
  onBuildDataset: () => void;
  onRefreshDatasets: () => void;
  t: TranslateFn;
}) {
  return (
    <section className={FINE_TUNING_SECTION_CLASS}>
      <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
        <div className="text-lg font-semibold text-txt">
          {t("finetuningview.Datasets1")}
        </div>
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
        <AgentTextInput
          agentId="dataset-limit"
          label="Limit trajectories"
          group="dataset-build"
          description="Maximum trajectories to include in the dataset"
          value={buildLimit}
          onChange={setBuildLimit}
          placeholder={t("finetuningview.LimitTrajectories")}
        />
        <AgentTextInput
          agentId="dataset-min-calls"
          label="Min LLM calls per trajectory"
          group="dataset-build"
          description="Minimum LLM calls required per trajectory"
          value={buildMinCalls}
          onChange={setBuildMinCalls}
          placeholder={t("finetuningview.MinLLMCallsPerTr")}
        />
        <AgentActionButton
          agentId="dataset-build"
          label="Build dataset"
          group="dataset-build"
          description="Build a training dataset from trajectories"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={datasetBuilding}
          onClick={onBuildDataset}
        >
          {datasetBuilding
            ? t("finetuningview.Building")
            : t("finetuningview.BuildDataset")}
        </AgentActionButton>
        <AgentActionButton
          agentId="dataset-refresh"
          label="Refresh datasets"
          group="dataset-build"
          description="Reload the dataset list"
          className={FINE_TUNING_ACTION_CLASS}
          onClick={onRefreshDatasets}
        >
          {t("finetuningview.RefreshDatasets")}
        </AgentActionButton>
      </div>
      <div className={`${FINE_TUNING_PANEL_CLASS} max-h-56 overflow-auto p-3`}>
        {datasets.length === 0 ? (
          <div className="text-sm text-muted">
            {t("finetuningview.NoDatasetsYet")}
          </div>
        ) : (
          <div className="space-y-2">
            {datasets.map((dataset) => (
              <DatasetRadioItem
                key={dataset.id}
                dataset={dataset}
                selectedDatasetId={selectedDatasetId}
                setSelectedDatasetId={setSelectedDatasetId}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
});

/* ── Jobs Section ──────────────────────────────────────────────────── */

export const TrainingJobsSection = memo(function TrainingJobsSection({
  selectedDatasetId,
  setSelectedDatasetId,
  datasets,
  startBackend,
  setStartBackend,
  startModel,
  setStartModel,
  startIterations,
  setStartIterations,
  startBatchSize,
  setStartBatchSize,
  startLearningRate,
  setStartLearningRate,
  startingJob,
  activeRunningJob,
  jobs,
  selectedJobId,
  setSelectedJobId,
  cancellingJobId,
  selectedJob,
  onStartJob,
  onRefreshJobs,
  onCancelJob,
  t,
}: {
  selectedDatasetId: string;
  setSelectedDatasetId: (value: string) => void;
  datasets: TrainingDatasetRecord[];
  startBackend: "mlx" | "cuda" | "cpu";
  setStartBackend: (value: "mlx" | "cuda" | "cpu") => void;
  startModel: string;
  setStartModel: (value: string) => void;
  startIterations: string;
  setStartIterations: (value: string) => void;
  startBatchSize: string;
  setStartBatchSize: (value: string) => void;
  startLearningRate: string;
  setStartLearningRate: (value: string) => void;
  startingJob: boolean;
  activeRunningJob: TrainingJobRecord | null;
  jobs: TrainingJobRecord[];
  selectedJobId: string;
  setSelectedJobId: (value: string) => void;
  cancellingJobId: string;
  selectedJob: TrainingJobRecord | null;
  onStartJob: () => void;
  onRefreshJobs: () => void;
  onCancelJob: (jobId: string) => void;
  t: TranslateFn;
}) {
  return (
    <section className={FINE_TUNING_SECTION_CLASS}>
      <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
        <div className="text-lg font-semibold text-txt">
          {t("finetuningview.TrainingJobs")}
        </div>
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        <AgentSelect
          agentId="job-dataset"
          label="Training dataset"
          group="job-config"
          description="Dataset to train the job on"
          value={selectedDatasetId}
          onValueChange={setSelectedDatasetId}
          options={[
            "__auto__",
            ...datasets.filter((dataset) => dataset.id).map((d) => d.id),
          ]}
          placeholder={t("finetuningview.AutoBuildDatasetF")}
        >
          <SelectContent>
            <SelectItem value="__auto__">
              {t("finetuningview.AutoBuildDatasetF")}
            </SelectItem>
            {datasets
              .filter((dataset) => dataset.id)
              .map((dataset) => (
                <SelectItem key={dataset.id} value={dataset.id}>
                  {dataset.id}
                </SelectItem>
              ))}
          </SelectContent>
        </AgentSelect>
        <AgentSelect
          agentId="job-backend"
          label="Training backend"
          group="job-config"
          description="Compute backend for the training job"
          value={startBackend}
          onValueChange={(value) =>
            setStartBackend(value as "mlx" | "cuda" | "cpu")
          }
          options={["cpu", "mlx", "cuda"]}
        >
          <SelectContent>
            <SelectItem value="cpu">{t("finetuningview.cpu")}</SelectItem>
            <SelectItem value="mlx">{t("finetuningview.mlx")}</SelectItem>
            <SelectItem value="cuda">{t("finetuningview.cuda")}</SelectItem>
          </SelectContent>
        </AgentSelect>
        <AgentTextInput
          agentId="job-base-model"
          label="Base model"
          group="job-config"
          description="Optional base model id for the training job"
          value={startModel}
          onChange={setStartModel}
          placeholder={t("finetuningview.BaseModelOptional")}
        />
        <AgentTextInput
          agentId="job-iterations"
          label="Iterations"
          group="job-config"
          description="Optional number of training iterations"
          value={startIterations}
          onChange={setStartIterations}
          placeholder={t("finetuningview.IterationsOptional")}
        />
        <AgentTextInput
          agentId="job-batch-size"
          label="Batch size"
          group="job-config"
          description="Optional training batch size"
          value={startBatchSize}
          onChange={setStartBatchSize}
          placeholder={t("finetuningview.BatchSizeOptional")}
        />
        <AgentTextInput
          agentId="job-learning-rate"
          label="Learning rate"
          group="job-config"
          description="Optional training learning rate"
          value={startLearningRate}
          onChange={setStartLearningRate}
          placeholder={t("finetuningview.LearningRateOptio")}
        />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <AgentActionButton
          agentId="job-start"
          label="Start training job"
          group="job-config"
          description="Start a new training job"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={startingJob || Boolean(activeRunningJob)}
          onClick={onStartJob}
        >
          {startingJob
            ? t("finetuningview.Starting")
            : t("finetuningview.StartTrainingJob")}
        </AgentActionButton>
        <AgentActionButton
          agentId="job-refresh"
          label="Refresh jobs"
          group="job-config"
          description="Reload the training jobs list"
          className={FINE_TUNING_ACTION_CLASS}
          onClick={onRefreshJobs}
        >
          {t("finetuningview.RefreshJobs")}
        </AgentActionButton>
        {activeRunningJob && (
          <div className="px-3 py-2 text-xs text-warn">
            {t("finetuningview.ActiveJob")}{" "}
            <span className="ml-1 font-mono">{activeRunningJob.id}</span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3">
        <div className={`${FINE_TUNING_PANEL_CLASS} max-h-64 overflow-auto`}>
          {jobs.length === 0 ? (
            <div className="p-4 text-sm text-muted">
              {t("finetuningview.NoJobsYet")}
            </div>
          ) : (
            jobs.map((job) => (
              <JobListItem
                key={job.id}
                job={job}
                selectedJobId={selectedJobId}
                setSelectedJobId={setSelectedJobId}
                cancellingJobId={cancellingJobId}
                onCancelJob={onCancelJob}
                t={t}
              />
            ))
          )}
        </div>
        <div className={`${FINE_TUNING_PANEL_CLASS} p-3`}>
          <SelectedJobPanel selectedJob={selectedJob} t={t} />
        </div>
      </div>
    </section>
  );
});

/* ── Trained Models Section ───────────────────────────────────────── */

export const TrainedModelsSection = memo(function TrainedModelsSection({
  activateProviderModel,
  importBaseModel,
  importModelName,
  importOllamaUrl,
  modelAction,
  models,
  onActivate,
  onBenchmark,
  onImport,
  onSmokeTest,
  selectedModel,
  selectedModelId,
  setActivateProviderModel,
  setImportBaseModel,
  setImportModelName,
  setImportOllamaUrl,
  setSelectedModelId,
  smokeResult,
  t,
}: {
  activateProviderModel: string;
  importBaseModel: string;
  importModelName: string;
  importOllamaUrl: string;
  modelAction: string;
  models: TrainingModelRecord[];
  onActivate: () => void;
  onBenchmark: () => void;
  onImport: () => void;
  onSmokeTest: () => void;
  selectedModel: TrainingModelRecord | null;
  selectedModelId: string;
  setActivateProviderModel: (value: string) => void;
  setImportBaseModel: (value: string) => void;
  setImportModelName: (value: string) => void;
  setImportOllamaUrl: (value: string) => void;
  setSelectedModelId: (value: string) => void;
  smokeResult: string | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <section className={FINE_TUNING_SECTION_CLASS}>
      <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
        <div className="text-lg font-semibold text-txt">
          {t("finetuningview.TrainedModels")}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3">
        <div className={`${FINE_TUNING_PANEL_CLASS} max-h-64 overflow-auto`}>
          {models.length === 0 ? (
            <div className="p-4 text-sm text-muted">
              {t("finetuningview.NoTrainedModelsYe")}
            </div>
          ) : (
            models.map((model) => (
              <ModelListItem
                key={model.id}
                model={model}
                selectedModelId={selectedModelId}
                setSelectedModelId={setSelectedModelId}
                t={t}
              />
            ))
          )}
        </div>
        <div className={`${FINE_TUNING_PANEL_CLASS} p-3`}>
          <SelectedModelPanel
            selectedModel={selectedModel}
            importModelName={importModelName}
            setImportModelName={setImportModelName}
            importBaseModel={importBaseModel}
            setImportBaseModel={setImportBaseModel}
            importOllamaUrl={importOllamaUrl}
            setImportOllamaUrl={setImportOllamaUrl}
            activateProviderModel={activateProviderModel}
            setActivateProviderModel={setActivateProviderModel}
            modelAction={modelAction}
            smokeResult={smokeResult}
            onImport={onImport}
            onActivate={onActivate}
            onBenchmark={onBenchmark}
            onSmokeTest={onSmokeTest}
            t={t}
          />
        </div>
      </div>
    </section>
  );
});

/* ── Live Events Panel ─────────────────────────────────────────────── */

export const LiveEventsPanel = memo(function LiveEventsPanel({
  events,
  t,
}: {
  events: TrainingStreamEvent[];
  t: TranslateFn;
}) {
  return (
    <section className={FINE_TUNING_SECTION_CLASS}>
      <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
        <div className="text-lg font-semibold text-txt">
          {t("finetuningview.LiveTrainingEvents")}
        </div>
      </div>
      <div className={`${FINE_TUNING_PANEL_CLASS} max-h-48 overflow-auto`}>
        {events.length === 0 ? (
          <div className="p-4 text-sm text-muted">
            {t("finetuningview.NoLiveEventsYet")}
          </div>
        ) : (
          events.slice(0, 80).map((event, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: stream events lack stable ids; ts+kind can repeat, index disambiguates
              key={`${event.ts}-${event.kind}-${index}`}
              className="px-3 py-2 text-sm"
            >
              <span className="mr-2 font-mono text-xs text-muted">
                {formatTime(event.ts, { fallback: "\u2014" })}
              </span>
              <span className="font-semibold">{event.kind}</span>
              {typeof event.progress === "number" && (
                <span className="text-muted">
                  {" "}
                  · {formatProgress(event.progress)}
                </span>
              )}
              {event.phase && (
                <span className="text-muted"> · {event.phase}</span>
              )}
              <div className="mt-0.5 text-xs text-muted">{event.message}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
});

/* ── Selected Job Detail Panel ─────────────────────────────────────── */

export function SelectedJobPanel({
  selectedJob,
  t,
}: {
  selectedJob: TrainingJobRecord | null;
  t: TranslateFn;
}) {
  if (!selectedJob) {
    return (
      <div className="text-sm text-muted">
        {t("finetuningview.SelectAJobToInsp")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm">
        <span className="font-semibold">{t("finetuningview.Status1")}</span>{" "}
        {selectedJob.status} · {formatProgress(selectedJob.progress)} ·{" "}
        {selectedJob.phase}
      </div>
      <div className="text-sm">
        <span className="font-semibold">{t("finetuningview.Dataset")}</span>{" "}
        <span className="font-mono">{selectedJob.datasetId}</span>
      </div>
      <SettingsControls.Textarea
        readOnly
        value={selectedJob.logs.join("\n")}
        className="max-h-72 min-h-40 overflow-auto font-mono text-xs"
      />
    </div>
  );
}

/* ── Selected Model Actions Panel ──────────────────────────────────── */

export function SelectedModelPanel({
  selectedModel,
  importModelName,
  setImportModelName,
  importBaseModel,
  setImportBaseModel,
  importOllamaUrl,
  setImportOllamaUrl,
  activateProviderModel,
  setActivateProviderModel,
  modelAction,
  smokeResult,
  onImport,
  onActivate,
  onBenchmark,
  onSmokeTest,
  t,
}: {
  selectedModel: TrainingModelRecord | null;
  importModelName: string;
  setImportModelName: (v: string) => void;
  importBaseModel: string;
  setImportBaseModel: (v: string) => void;
  importOllamaUrl: string;
  setImportOllamaUrl: (v: string) => void;
  activateProviderModel: string;
  setActivateProviderModel: (v: string) => void;
  modelAction: string;
  smokeResult: string | null;
  onImport: () => void;
  onActivate: () => void;
  onBenchmark: () => void;
  onSmokeTest: () => void;
  t: TranslateFn;
}) {
  if (!selectedModel) {
    return (
      <div className="text-sm text-muted">
        {t("finetuningview.SelectAModelToIm")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm">
        <span className="font-semibold">{t("finetuningview.Model")}</span>{" "}
        <span className="font-mono">{selectedModel.id}</span>
      </div>
      <div className="text-sm">
        <span className="font-semibold">{t("finetuningview.AdapterPath")}</span>{" "}
        <span className="font-mono">{selectedModel.adapterPath ?? "n/a"}</span>
      </div>

      <AgentTextInput
        agentId="model-import-name"
        label="Ollama model name"
        group="model-actions"
        description="Name for the imported Ollama model"
        value={importModelName}
        onChange={setImportModelName}
        placeholder={t("finetuningview.OllamaModelNameO")}
      />
      <AgentTextInput
        agentId="model-import-base"
        label="Base model for Ollama"
        group="model-actions"
        description="Base model used for the Ollama import"
        value={importBaseModel}
        onChange={setImportBaseModel}
        placeholder={t("finetuningview.BaseModelForOllam")}
      />
      <AgentTextInput
        agentId="model-import-url"
        label="Ollama URL"
        group="model-actions"
        description="Ollama server URL for the import"
        value={importOllamaUrl}
        onChange={setImportOllamaUrl}
        placeholder={t("finetuningview.OllamaURL")}
      />
      <AgentActionButton
        agentId="model-import"
        label="Import to Ollama"
        group="model-actions"
        description="Import the selected model into Ollama"
        className={FINE_TUNING_ACTION_CLASS}
        disabled={modelAction === `import:${selectedModel.id}`}
        onClick={onImport}
      >
        {modelAction === `import:${selectedModel.id}`
          ? t("finetuningview.Importing")
          : t("finetuningview.ImportToOllama")}
      </AgentActionButton>

      <AgentTextInput
        agentId="model-provider-model"
        label="Provider model"
        group="model-actions"
        description="Provider model id to activate"
        value={activateProviderModel}
        onChange={setActivateProviderModel}
        placeholder={t("finetuningview.ProviderModelEG")}
      />
      <div className="flex flex-wrap gap-2">
        <AgentActionButton
          agentId="model-activate"
          label="Activate model"
          group="model-actions"
          description="Activate the selected model"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={modelAction === `activate:${selectedModel.id}`}
          onClick={onActivate}
        >
          {modelAction === `activate:${selectedModel.id}`
            ? t("finetuningview.Activating")
            : t("finetuningview.ActivateModel")}
        </AgentActionButton>
        <AgentActionButton
          agentId="model-benchmark"
          label="Benchmark model"
          group="model-actions"
          description="Run a benchmark against the selected model"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={modelAction === `benchmark:${selectedModel.id}`}
          onClick={onBenchmark}
        >
          {modelAction === `benchmark:${selectedModel.id}`
            ? t("finetuningview.Benchmarking")
            : t("finetuningview.BenchmarkAction")}
        </AgentActionButton>
        <AgentActionButton
          agentId="model-smoke-test"
          label="Run smoke prompt"
          group="model-actions"
          description="Run a smoke-test prompt against the selected model"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={modelAction === `smoke:${selectedModel.id}`}
          onClick={onSmokeTest}
        >
          {modelAction === `smoke:${selectedModel.id}`
            ? t("finetuningview.Testing")
            : t("finetuningview.RunSmokePrompt")}
        </AgentActionButton>
      </div>
      {smokeResult && (
        <SettingsControls.Textarea
          readOnly
          value={smokeResult}
          className="max-h-48 min-h-24 overflow-auto"
        />
      )}
    </div>
  );
}
