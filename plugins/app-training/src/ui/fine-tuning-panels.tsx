import {
  Button,
  formatTime,
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
  type StreamEventEnvelope,
  type TrainingDatasetRecord,
  type TrainingJobRecord,
  type TrainingModelRecord,
  type TrainingStreamEvent,
  type TrainingTrajectoryDetail,
  type TrainingTrajectoryList,
} from "@elizaos/ui";

/* ── Constants ─────────────────────────────────────────────────────── */

export const TRAINING_EVENT_KINDS = new Set<TrainingStreamEvent["kind"]>([
  "job_started",
  "job_progress",
  "job_log",
  "job_completed",
  "job_failed",
  "job_cancelled",
  "dataset_built",
  "model_activated",
  "model_imported",
]);

export const FINE_TUNING_PAGE_CLASS = "space-y-6 pb-8";
export const FINE_TUNING_SECTION_CLASS =
  "rounded-2xl border border-border/60 bg-card/70 p-5 shadow-sm ring-1 ring-border/15";
export const FINE_TUNING_SECTION_HEADER_CLASS =
  "mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between";
export const FINE_TUNING_SECTION_KICKER_CLASS =
  "text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70";
export const FINE_TUNING_PANEL_CLASS =
  "rounded-2xl border border-border/45 bg-bg/20 shadow-sm";
export const FINE_TUNING_PANEL_HEADER_CLASS =
  "px-3 py-2 text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70";
export const FINE_TUNING_ACTION_CLASS =
  "h-10 rounded-xl px-3 text-xs shadow-sm hover:border-accent disabled:opacity-50";
export const FINE_TUNING_STATUS_CARD_CLASS =
  "rounded-xl border border-border/35 bg-bg/30 px-3 py-3 shadow-sm";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/* ── Formatting helpers ────────────────────────────────────────────── */

export function formatDate(value: string | null): string {
  if (!value) return "\u2014";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export function formatProgress(value: number): string {
  const bounded = Math.max(0, Math.min(1, value));
  return `${Math.round(bounded * 100)}%`;
}

/* ── Event parsing ─────────────────────────────────────────────────── */

export function asTrainingEvent(
  envelope: Partial<StreamEventEnvelope>,
): TrainingStreamEvent | null {
  if (envelope.type !== "training_event") return null;
  const payloadValue = envelope.payload;
  if (!payloadValue || typeof payloadValue !== "object") return null;
  const payload = payloadValue as Partial<TrainingStreamEvent>;
  if (typeof payload.kind !== "string") return null;
  if (!TRAINING_EVENT_KINDS.has(payload.kind as TrainingStreamEvent["kind"])) {
    return null;
  }
  if (typeof payload.ts !== "number") return null;
  if (typeof payload.message !== "string") return null;
  return {
    kind: payload.kind as TrainingStreamEvent["kind"],
    ts: payload.ts,
    message: payload.message,
    jobId: typeof payload.jobId === "string" ? payload.jobId : undefined,
    modelId: typeof payload.modelId === "string" ? payload.modelId : undefined,
    datasetId:
      typeof payload.datasetId === "string" ? payload.datasetId : undefined,
    progress:
      typeof payload.progress === "number" ? payload.progress : undefined,
    phase: typeof payload.phase === "string" ? payload.phase : undefined,
  };
}

/* ── Availability summary ──────────────────────────────────────────── */

export function summarizeAvailability(
  reason: string | undefined,
  t: TranslateFn,
): string {
  if (!reason) return t("finetuningview.Unavailable");
  if (reason === "runtime_not_started") {
    return t("finetuningview.RuntimeNotStarted");
  }
  if (reason === "trajectories_table_missing") {
    return t("finetuningview.NoTrajectoriesTableFound");
  }
  return reason;
}

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
        <div className="space-y-1">
          <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
            {t("finetuningview.DataReview")}
          </div>
          <div className="text-lg font-semibold text-txt">
            {t("finetuningview.Trajectories")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className={FINE_TUNING_ACTION_CLASS}
            disabled={publishingTrajectories || !publishConfigured}
            onClick={onPublishTrajectories}
          >
            {publishingTrajectories
              ? t("finetuningview.Publishing")
              : t("finetuningview.PublishToHuggingFace")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={FINE_TUNING_ACTION_CLASS}
            onClick={onRefresh}
          >
            {t("common.refresh")}
          </Button>
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
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className={FINE_TUNING_PANEL_CLASS}>
              <div className={FINE_TUNING_PANEL_HEADER_CLASS}>
                {t("finetuningview.LatestTrajectories")}
              </div>
              <div className="max-h-72 overflow-auto">
                {trajectoryList.trajectories.length === 0 ? (
                  <div className="p-3 text-xs text-muted">
                    {t("finetuningview.NoTrajectoriesFoun")}
                  </div>
                ) : (
                  trajectoryList.trajectories.map((trajectory) => (
                    <Button
                      variant="ghost"
                      key={trajectory.trajectoryId}
                      className="w-full justify-start rounded-none px-3 py-3 text-left text-xs hover:bg-bg-hover"
                      onClick={() =>
                        onSelectTrajectory(trajectory.trajectoryId)
                      }
                    >
                      <div className="font-mono">{trajectory.trajectoryId}</div>
                      <div className="text-muted mt-1">
                        {t("finetuningview.Calls")} {trajectory.llmCallCount}{" "}
                        {t("finetuningview.Reward")}{" "}
                        {trajectory.totalReward ?? "n/a"} ·{" "}
                        {formatDate(trajectory.createdAt)}
                      </div>
                    </Button>
                  ))
                )}
              </div>
            </div>
            <div className={`${FINE_TUNING_PANEL_CLASS} p-3`}>
              <div className="mb-2 text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.SelectedTrajectory")}
              </div>
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
                    className="min-h-56"
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

export function DatasetSection({
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
        <div className="space-y-1">
          <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
            {t("finetuningview.DatasetBuild")}
          </div>
          <div className="text-lg font-semibold text-txt">
            {t("finetuningview.Datasets1")}
          </div>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
        <SettingsControls.Input
          variant="filter"
          value={buildLimit}
          onChange={(event) => setBuildLimit(event.target.value)}
          placeholder={t("finetuningview.LimitTrajectories")}
        />
        <SettingsControls.Input
          variant="filter"
          value={buildMinCalls}
          onChange={(event) => setBuildMinCalls(event.target.value)}
          placeholder={t("finetuningview.MinLLMCallsPerTr")}
        />
        <Button
          variant="outline"
          size="sm"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={datasetBuilding}
          onClick={onBuildDataset}
        >
          {datasetBuilding
            ? t("finetuningview.Building")
            : t("finetuningview.BuildDataset")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={FINE_TUNING_ACTION_CLASS}
          onClick={onRefreshDatasets}
        >
          {t("finetuningview.RefreshDatasets")}
        </Button>
      </div>
      <div className={`${FINE_TUNING_PANEL_CLASS} max-h-60 overflow-auto p-3`}>
        {datasets.length === 0 ? (
          <div className="text-sm text-muted">
            {t("finetuningview.NoDatasetsYet")}
          </div>
        ) : (
          <div className="space-y-2">
            {datasets.map((dataset) => (
              <label
                key={dataset.id}
                className="flex min-h-touch cursor-pointer items-center gap-3 rounded-xl border border-border/35 bg-bg/20 px-3 py-3 text-sm transition-colors hover:border-border/55 hover:bg-bg/35"
              >
                <input
                  type="radio"
                  name="dataset-select"
                  checked={selectedDatasetId === dataset.id}
                  onChange={() => setSelectedDatasetId(dataset.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm text-txt">{dataset.id}</div>
                  <div className="mt-1 text-xs text-muted">
                    {dataset.sampleCount} {t("finetuningview.samples")}{" "}
                    {dataset.trajectoryCount} {t("finetuningview.trajectories")}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ── Jobs Section ──────────────────────────────────────────────────── */

export function TrainingJobsSection({
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
        <div className="space-y-1">
          <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
            {t("finetuningview.Training")}
          </div>
          <div className="text-lg font-semibold text-txt">
            {t("finetuningview.TrainingJobs")}
          </div>
        </div>
      </div>
      <div className="mb-3 rounded-xl border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-muted">
        {t("finetuningview.GpuFineTunesViaVast")}
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-3">
        <Select
          value={selectedDatasetId}
          onValueChange={(value: string) => setSelectedDatasetId(value)}
        >
          <SettingsControls.SelectTrigger variant="toolbar">
            <SelectValue placeholder={t("finetuningview.AutoBuildDatasetF")} />
          </SettingsControls.SelectTrigger>
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
        </Select>
        <Select
          value={startBackend}
          onValueChange={(value: string) =>
            setStartBackend(value as "mlx" | "cuda" | "cpu")
          }
        >
          <SettingsControls.SelectTrigger variant="toolbar">
            <SelectValue />
          </SettingsControls.SelectTrigger>
          <SelectContent>
            <SelectItem value="cpu">{t("finetuningview.cpu")}</SelectItem>
            <SelectItem value="mlx">{t("finetuningview.mlx")}</SelectItem>
            <SelectItem value="cuda">{t("finetuningview.cuda")}</SelectItem>
          </SelectContent>
        </Select>
        <SettingsControls.Input
          variant="filter"
          value={startModel}
          onChange={(event) => setStartModel(event.target.value)}
          placeholder={t("finetuningview.BaseModelOptional")}
        />
        <SettingsControls.Input
          variant="filter"
          value={startIterations}
          onChange={(event) => setStartIterations(event.target.value)}
          placeholder={t("finetuningview.IterationsOptional")}
        />
        <SettingsControls.Input
          variant="filter"
          value={startBatchSize}
          onChange={(event) => setStartBatchSize(event.target.value)}
          placeholder={t("finetuningview.BatchSizeOptional")}
        />
        <SettingsControls.Input
          variant="filter"
          value={startLearningRate}
          onChange={(event) => setStartLearningRate(event.target.value)}
          placeholder={t("finetuningview.LearningRateOptio")}
        />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={startingJob || Boolean(activeRunningJob)}
          onClick={onStartJob}
        >
          {startingJob
            ? t("finetuningview.Starting")
            : t("finetuningview.StartTrainingJob")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={FINE_TUNING_ACTION_CLASS}
          onClick={onRefreshJobs}
        >
          {t("finetuningview.RefreshJobs")}
        </Button>
        {activeRunningJob && (
          <div className="rounded-full border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            {t("finetuningview.ActiveJob")}{" "}
            <span className="ml-1 font-mono">{activeRunningJob.id}</span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className={`${FINE_TUNING_PANEL_CLASS} max-h-72 overflow-auto`}>
          {jobs.length === 0 ? (
            <div className="p-4 text-sm text-muted">
              {t("finetuningview.NoJobsYet")}
            </div>
          ) : (
            jobs.map((job) => (
              <div
                key={job.id}
                className={`px-3 py-3 text-sm ${
                  selectedJobId === job.id ? "bg-bg-hover" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="link"
                    className="h-auto w-auto justify-start p-0 text-left font-mono text-sm"
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    {job.id}
                  </Button>
                  {(job.status === "running" || job.status === "queued") && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-xl border-danger/35 px-3 text-xs-tight text-danger shadow-sm hover:border-danger hover:bg-danger/10 disabled:opacity-50"
                      disabled={cancellingJobId === job.id}
                      onClick={() => onCancelJob(job.id)}
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
                <div className="text-xs text-muted">
                  {formatDate(job.createdAt)}
                </div>
              </div>
            ))
          )}
        </div>
        <div className={`${FINE_TUNING_PANEL_CLASS} p-3`}>
          <div className="mb-2 text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
            {t("finetuningview.SelectedJobLogs")}
          </div>
          <SelectedJobPanel selectedJob={selectedJob} t={t} />
        </div>
      </div>
    </section>
  );
}

/* ── Trained Models Section ───────────────────────────────────────── */

export function TrainedModelsSection({
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
        <div className="space-y-1">
          <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
            {t("finetuningview.ModelOps")}
          </div>
          <div className="text-lg font-semibold text-txt">
            {t("finetuningview.TrainedModels")}
          </div>
        </div>
      </div>
      <div className="mb-3 rounded-xl border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-muted">
        {t("finetuningview.ModelOpsNotWiredHere")}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className={`${FINE_TUNING_PANEL_CLASS} max-h-72 overflow-auto`}>
          {models.length === 0 ? (
            <div className="p-4 text-sm text-muted">
              {t("finetuningview.NoTrainedModelsYe")}
            </div>
          ) : (
            models.map((model) => (
              <Button
                variant="ghost"
                key={model.id}
                className={`w-full justify-start rounded-none px-3 py-3 text-left text-sm ${
                  selectedModelId === model.id
                    ? "bg-bg-hover"
                    : "hover:bg-bg-hover"
                }`}
                onClick={() => setSelectedModelId(model.id)}
              >
                <div className="font-mono">
                  {model.id}{" "}
                  {model.active ? t("finetuningview.ActiveIndicator") : ""}
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
            ))
          )}
        </div>
        <div className={`${FINE_TUNING_PANEL_CLASS} p-3`}>
          <div className="mb-2 text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
            {t("finetuningview.ModelActions")}
          </div>
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
}

/* ── Live Events Panel ─────────────────────────────────────────────── */

export function LiveEventsPanel({
  events,
  t,
}: {
  events: TrainingStreamEvent[];
  t: TranslateFn;
}) {
  return (
    <section className={FINE_TUNING_SECTION_CLASS}>
      <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
        <div className="space-y-1">
          <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
            {t("finetuningview.Streaming")}
          </div>
          <div className="text-lg font-semibold text-txt">
            {t("finetuningview.LiveTrainingEvents")}
          </div>
        </div>
      </div>
      <div className={`${FINE_TUNING_PANEL_CLASS} max-h-56 overflow-auto`}>
        {events.length === 0 ? (
          <div className="p-4 text-sm text-muted">
            {t("finetuningview.NoLiveEventsYet")}
          </div>
        ) : (
          events.map((event) => (
            <div
              key={`${event.ts}-${event.kind}-${String(event.message ?? "")}`}
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
}

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
        className="min-h-56"
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

      <SettingsControls.Input
        variant="filter"
        value={importModelName}
        onChange={(event) => setImportModelName(event.target.value)}
        placeholder={t("finetuningview.OllamaModelNameO")}
      />
      <SettingsControls.Input
        variant="filter"
        value={importBaseModel}
        onChange={(event) => setImportBaseModel(event.target.value)}
        placeholder={t("finetuningview.BaseModelForOllam")}
      />
      <SettingsControls.Input
        variant="filter"
        value={importOllamaUrl}
        onChange={(event) => setImportOllamaUrl(event.target.value)}
        placeholder={t("finetuningview.OllamaURL")}
      />
      <Button
        variant="outline"
        size="sm"
        className={FINE_TUNING_ACTION_CLASS}
        disabled={modelAction === `import:${selectedModel.id}`}
        onClick={onImport}
      >
        {modelAction === `import:${selectedModel.id}`
          ? t("finetuningview.Importing")
          : t("finetuningview.ImportToOllama")}
      </Button>

      <SettingsControls.Input
        variant="filter"
        value={activateProviderModel}
        onChange={(event) => setActivateProviderModel(event.target.value)}
        placeholder={t("finetuningview.ProviderModelEG")}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={modelAction === `activate:${selectedModel.id}`}
          onClick={onActivate}
        >
          {modelAction === `activate:${selectedModel.id}`
            ? t("finetuningview.Activating")
            : t("finetuningview.ActivateModel")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={modelAction === `benchmark:${selectedModel.id}`}
          onClick={onBenchmark}
        >
          {modelAction === `benchmark:${selectedModel.id}`
            ? t("finetuningview.Benchmarking")
            : t("finetuningview.BenchmarkAction")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={FINE_TUNING_ACTION_CLASS}
          disabled={modelAction === `smoke:${selectedModel.id}`}
          onClick={onSmokeTest}
        >
          {modelAction === `smoke:${selectedModel.id}`
            ? t("finetuningview.Testing")
            : t("finetuningview.RunSmokePrompt")}
        </Button>
      </div>
      {smokeResult && (
        <SettingsControls.Textarea
          readOnly
          value={smokeResult}
          className="min-h-24"
        />
      )}
    </div>
  );
}
