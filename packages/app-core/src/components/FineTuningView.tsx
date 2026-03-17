import {
  client,
  type StartTrainingOptions,
  type StreamEventEnvelope,
  type TrainingDatasetRecord,
  type TrainingJobRecord,
  type TrainingModelRecord,
  type TrainingStatus,
  type TrainingStreamEvent,
  type TrainingTrajectoryDetail,
  type TrainingTrajectoryList,
} from "@elizaos/app-core/api";
import { formatTime } from "@elizaos/app-core/components";
import { useApp } from "@elizaos/app-core/state";
import { confirmDesktopAction } from "@elizaos/app-core/utils";
import { Button, Input } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import {
  parsePositiveFloat,
  parsePositiveInteger,
} from "../utils/number-parsing";

const TRAINING_EVENT_KINDS = new Set<TrainingStreamEvent["kind"]>([
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

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatProgress(value: number): string {
  const bounded = Math.max(0, Math.min(1, value));
  return `${Math.round(bounded * 100)}%`;
}

function asTrainingEvent(
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

function summarizeAvailability(reason?: string): string {
  if (!reason) return "Unavailable";
  if (reason === "runtime_not_started") return "Agent runtime is not started.";
  if (reason === "trajectories_table_missing") {
    return "No trajectories table found yet. Generate trajectories first.";
  }
  return reason;
}

export function FineTuningView() {
  const { handleRestart, setActionNotice, t } = useApp();

  const [pageLoading, setPageLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [status, setStatus] = useState<TrainingStatus | null>(null);
  const [trajectoryList, setTrajectoryList] = useState<TrainingTrajectoryList>({
    available: false,
    total: 0,
    trajectories: [],
  });
  const [selectedTrajectory, setSelectedTrajectory] =
    useState<TrainingTrajectoryDetail | null>(null);
  const [trajectoryLoading, setTrajectoryLoading] = useState(false);

  const [datasets, setDatasets] = useState<TrainingDatasetRecord[]>([]);
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [models, setModels] = useState<TrainingModelRecord[]>([]);

  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");

  const [buildLimit, setBuildLimit] = useState("250");
  const [buildMinCalls, setBuildMinCalls] = useState("1");
  const [datasetBuilding, setDatasetBuilding] = useState(false);

  const [startBackend, setStartBackend] = useState<"mlx" | "cuda" | "cpu">(
    "cpu",
  );
  const [startModel, setStartModel] = useState("");
  const [startIterations, setStartIterations] = useState("");
  const [startBatchSize, setStartBatchSize] = useState("");
  const [startLearningRate, setStartLearningRate] = useState("");
  const [startingJob, setStartingJob] = useState(false);
  const [cancellingJobId, setCancellingJobId] = useState("");

  const [importModelName, setImportModelName] = useState("");
  const [importBaseModel, setImportBaseModel] = useState("");
  const [importOllamaUrl, setImportOllamaUrl] = useState(
    "http://localhost:11434",
  );
  const [activateProviderModel, setActivateProviderModel] = useState("");
  const [modelAction, setModelAction] = useState("");
  const [smokeResult, setSmokeResult] = useState<string | null>(null);

  const [trainingEvents, setTrainingEvents] = useState<TrainingStreamEvent[]>(
    [],
  );

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedModel =
    models.find((model) => model.id === selectedModelId) ?? null;
  const activeRunningJob =
    jobs.find((job) => job.status === "running" || job.status === "queued") ??
    null;

  const loadStatus = useCallback(async () => {
    const nextStatus = await client.getTrainingStatus();
    setStatus(nextStatus);
  }, []);

  const loadTrajectories = useCallback(async () => {
    const listed = await client.listTrainingTrajectories({
      limit: 100,
      offset: 0,
    });
    setTrajectoryList(listed);
  }, []);

  const loadDatasets = useCallback(async () => {
    const listed = await client.listTrainingDatasets();
    setDatasets(listed.datasets);
    setSelectedDatasetId((prev) => {
      if (prev && listed.datasets.some((dataset) => dataset.id === prev)) {
        return prev;
      }
      return listed.datasets[0]?.id ?? "";
    });
  }, []);

  const loadJobs = useCallback(async () => {
    const listed = await client.listTrainingJobs();
    setJobs(listed.jobs);
    setSelectedJobId((prev) => {
      if (prev && listed.jobs.some((job) => job.id === prev)) return prev;
      return listed.jobs[0]?.id ?? "";
    });
  }, []);

  const loadModels = useCallback(async () => {
    const listed = await client.listTrainingModels();
    setModels(listed.models);
    setSelectedModelId((prev) => {
      if (prev && listed.models.some((model) => model.id === prev)) return prev;
      return listed.models[0]?.id ?? "";
    });
  }, []);

  const refreshAll = useCallback(async () => {
    setPageLoading(true);
    setErrorMessage(null);
    try {
      await Promise.all([
        loadStatus(),
        loadTrajectories(),
        loadDatasets(),
        loadJobs(),
        loadModels(),
      ]);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to refresh fine-tuning state.",
      );
    } finally {
      setPageLoading(false);
    }
  }, [loadDatasets, loadJobs, loadModels, loadStatus, loadTrajectories]);

  const loadTrajectoryDetail = useCallback(
    async (trajectoryId: string) => {
      setTrajectoryLoading(true);
      try {
        const result = await client.getTrainingTrajectory(trajectoryId);
        setSelectedTrajectory(result.trajectory);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to load trajectory detail.";
        setActionNotice(message, "error", 4200);
      } finally {
        setTrajectoryLoading(false);
      }
    },
    [setActionNotice],
  );

  const handleBuildDataset = useCallback(async () => {
    setDatasetBuilding(true);
    try {
      const limit = parsePositiveInteger(buildLimit);
      const minLlmCallsPerTrajectory = parsePositiveInteger(buildMinCalls);
      const request: { limit?: number; minLlmCallsPerTrajectory?: number } = {};
      if (typeof limit === "number") request.limit = limit;
      if (typeof minLlmCallsPerTrajectory === "number") {
        request.minLlmCallsPerTrajectory = minLlmCallsPerTrajectory;
      }

      const result = await client.buildTrainingDataset(request);
      setSelectedDatasetId(result.dataset.id);
      await Promise.all([loadDatasets(), loadStatus()]);
      setActionNotice(
        `Built dataset ${result.dataset.id} (${result.dataset.sampleCount} samples).`,
        "success",
        3800,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : "Failed to build dataset.",
        "error",
        4200,
      );
    } finally {
      setDatasetBuilding(false);
    }
  }, [buildLimit, buildMinCalls, loadDatasets, loadStatus, setActionNotice]);

  const handleStartJob = useCallback(async () => {
    setStartingJob(true);
    try {
      const options: StartTrainingOptions = {
        datasetId: selectedDatasetId || undefined,
        backend: startBackend,
        model: startModel.trim() || undefined,
        iterations: parsePositiveInteger(startIterations),
        batchSize: parsePositiveInteger(startBatchSize),
        learningRate: parsePositiveFloat(startLearningRate),
      };
      const result = await client.startTrainingJob(options);
      setSelectedJobId(result.job.id);
      await Promise.all([loadJobs(), loadStatus()]);
      setActionNotice(
        `Started training job ${result.job.id}.`,
        "success",
        3200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : "Failed to start training job.",
        "error",
        4200,
      );
    } finally {
      setStartingJob(false);
    }
  }, [
    loadJobs,
    loadStatus,
    selectedDatasetId,
    setActionNotice,
    startBackend,
    startBatchSize,
    startIterations,
    startLearningRate,
    startModel,
  ]);

  const handleCancelJob = useCallback(
    async (jobId: string) => {
      setCancellingJobId(jobId);
      try {
        await client.cancelTrainingJob(jobId);
        await Promise.all([loadJobs(), loadStatus()]);
        setActionNotice(`Cancelled job ${jobId}.`, "success", 2600);
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : `Failed to cancel ${jobId}.`,
          "error",
          4200,
        );
      } finally {
        setCancellingJobId("");
      }
    },
    [loadJobs, loadStatus, setActionNotice],
  );

  const handleImportSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `import:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.importTrainingModelToOllama(
        selectedModel.id,
        {
          modelName: importModelName.trim() || undefined,
          baseModel: importBaseModel.trim() || undefined,
          ollamaUrl: importOllamaUrl.trim() || undefined,
        },
      );
      await loadModels();
      setActivateProviderModel(
        result.model.ollamaModel ? `ollama/${result.model.ollamaModel}` : "",
      );
      setActionNotice(
        `Imported model ${result.model.id} to Ollama${result.model.ollamaModel ? ` as ${result.model.ollamaModel}` : ""}.`,
        "success",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : "Failed to import model to Ollama.",
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [
    importBaseModel,
    importModelName,
    importOllamaUrl,
    loadModels,
    selectedModel,
    setActionNotice,
  ]);

  const handleActivateSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `activate:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.activateTrainingModel(
        selectedModel.id,
        activateProviderModel.trim() || undefined,
      );
      await loadModels();
      setActionNotice(
        `Activated model ${result.modelId} as ${result.providerModel}.`,
        "success",
        4200,
      );
      if (result.needsRestart) {
        const shouldRestart = await confirmDesktopAction({
          title: "Restart Agent",
          message:
            "Model activation was saved. Restart the agent now to load the new model?",
          confirmLabel: "Restart",
          cancelLabel: "Later",
          type: "question",
        });
        if (shouldRestart) {
          await handleRestart();
        }
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : "Failed to activate model.",
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [
    activateProviderModel,
    handleRestart,
    loadModels,
    selectedModel,
    setActionNotice,
  ]);

  const handleBenchmarkSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `benchmark:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.benchmarkTrainingModel(selectedModel.id);
      await loadModels();
      setActionNotice(
        `Benchmark ${result.status} for ${selectedModel.id}.`,
        result.status === "passed" ? "success" : "error",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : "Failed to benchmark model.",
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [loadModels, selectedModel, setActionNotice]);

  const handleSmokeTestSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `smoke:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.sendChatRest(
        "Model smoke test. Reply with exactly: MODEL_OK",
      );
      setSmokeResult(result.text);
      setActionNotice("Smoke test completed.", "success", 3200);
    } catch (err) {
      setSmokeResult(null);
      setActionNotice(
        err instanceof Error ? err.message : "Failed to run smoke test.",
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [selectedModel, setActionNotice]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadStatus();
      void loadJobs();
      void loadModels();
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadJobs, loadModels, loadStatus]);

  useEffect(() => {
    const unbind = client.onWsEvent("training_event", (rawEnvelope) => {
      const event = asTrainingEvent(
        rawEnvelope as Partial<StreamEventEnvelope>,
      );
      if (!event) return;
      setTrainingEvents((prev) => {
        const merged = [event, ...prev];
        return merged.slice(0, 240);
      });
      if (event.kind !== "job_log") {
        void loadStatus();
        void loadJobs();
        void loadModels();
        if (event.kind === "dataset_built") {
          void loadDatasets();
        }
      }
    });
    return () => {
      unbind();
    };
  }, [loadDatasets, loadJobs, loadModels, loadStatus]);

  if (pageLoading) {
    return (
      <div className="text-sm text-muted">
        {t("finetuningview.LoadingFineTuning")}
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      <section className="border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {t("finetuningview.FineTuning")}
            </h2>
            <p className="text-xs text-muted mt-1">
              {t("finetuningview.BuildDatasetsFrom")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="px-3 py-1 h-7 text-xs shadow-sm hover:border-accent"
            onClick={() => {
              void refreshAll();
            }}
          >
            {t("finetuningview.RefreshAll")}
          </Button>
        </div>
        {errorMessage && (
          <div className="mt-3 text-xs text-danger border border-danger p-2">
            {errorMessage}
          </div>
        )}
      </section>

      <section className="border border-border bg-card p-4">
        <h3 className="text-sm font-bold mb-3">{t("finetuningview.Status")}</h3>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
          <div>
            {t("finetuningview.Runtime")}{" "}
            {status?.runtimeAvailable ? "ready" : "offline"}
          </div>
          <div>
            {t("finetuningview.RunningJobs")} {status?.runningJobs ?? 0}
          </div>
          <div>
            {t("finetuningview.QueuedJobs")} {status?.queuedJobs ?? 0}
          </div>
          <div>
            {t("finetuningview.Datasets")} {status?.datasetCount ?? 0}
          </div>
          <div>
            {t("finetuningview.Models")} {status?.modelCount ?? 0}
          </div>
          <div>
            {t("finetuningview.FailedJobs")} {status?.failedJobs ?? 0}
          </div>
        </div>
      </section>

      <section className="border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-bold">
            {t("finetuningview.Trajectories")}
          </h3>
          <Button
            variant="outline"
            size="sm"
            className="px-2 py-1 h-6 text-xs shadow-sm hover:border-accent"
            onClick={() => {
              void loadTrajectories();
            }}
          >
            {t("appsview.Refresh")}
          </Button>
        </div>
        {!trajectoryList.available ? (
          <div className="text-xs text-muted">
            {summarizeAvailability(trajectoryList.reason)}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-muted">
              {trajectoryList.total} {t("finetuningview.trajectoryRowsAvai")}
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="border border-border">
                <div className="px-2 py-1 text-[11px] border-b border-border text-muted">
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
                        className="w-full h-auto text-left justify-start flex-col items-start px-2 py-2 border-b border-border rounded-none hover:bg-bg-hover text-xs"
                        onClick={() => {
                          void loadTrajectoryDetail(trajectory.trajectoryId);
                        }}
                      >
                        <div className="font-mono">
                          {trajectory.trajectoryId}
                        </div>
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
              <div className="border border-border p-2">
                <div className="text-[11px] text-muted mb-2">
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
                    <textarea
                      readOnly
                      value={selectedTrajectory.stepsJson}
                      className="w-full min-h-56 px-2 py-1 border border-border bg-bg text-[11px] font-mono"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="border border-border bg-card p-4">
        <h3 className="text-sm font-bold mb-3">
          {t("finetuningview.Datasets1")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
          <Input
            className="px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
            value={buildLimit}
            onChange={(event) => setBuildLimit(event.target.value)}
            placeholder={t("finetuningview.LimitTrajectories")}
          />
          <Input
            className="px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
            value={buildMinCalls}
            onChange={(event) => setBuildMinCalls(event.target.value)}
            placeholder={t("finetuningview.MinLLMCallsPerTr")}
          />
          <Button
            variant="outline"
            size="sm"
            className="px-3 py-1 h-8 text-xs shadow-sm hover:border-accent disabled:opacity-50"
            disabled={datasetBuilding}
            onClick={() => {
              void handleBuildDataset();
            }}
          >
            {datasetBuilding ? "Building..." : "Build Dataset"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="px-3 py-1 h-8 text-xs shadow-sm hover:border-accent"
            onClick={() => {
              void loadDatasets();
            }}
          >
            {t("finetuningview.RefreshDatasets")}
          </Button>
        </div>
        <div className="space-y-2 max-h-52 overflow-auto">
          {datasets.length === 0 ? (
            <div className="text-xs text-muted">
              {t("finetuningview.NoDatasetsYet")}
            </div>
          ) : (
            datasets.map((dataset) => (
              <label
                key={dataset.id}
                className="flex items-center gap-2 text-xs border border-border px-2 py-2 cursor-pointer"
              >
                <input
                  type="radio"
                  name="dataset-select"
                  checked={selectedDatasetId === dataset.id}
                  onChange={() => setSelectedDatasetId(dataset.id)}
                />
                <span className="font-mono">{dataset.id}</span>
                <span className="text-muted">
                  {dataset.sampleCount} {t("finetuningview.samples")}{" "}
                  {dataset.trajectoryCount} {t("finetuningview.trajectories")}
                </span>
              </label>
            ))
          )}
        </div>
      </section>

      <section className="border border-border bg-card p-4">
        <h3 className="text-sm font-bold mb-3">
          {t("finetuningview.TrainingJobs")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
          <select
            className="px-2 py-1 border border-border bg-bg text-sm"
            value={selectedDatasetId}
            onChange={(event) => setSelectedDatasetId(event.target.value)}
          >
            <option value="">{t("finetuningview.AutoBuildDatasetF")}</option>
            {datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.id}
              </option>
            ))}
          </select>
          <select
            className="px-2 py-1 border border-border bg-bg text-sm"
            value={startBackend}
            onChange={(event) =>
              setStartBackend(event.target.value as "mlx" | "cuda" | "cpu")
            }
          >
            <option value="cpu">{t("finetuningview.cpu")}</option>
            <option value="mlx">{t("finetuningview.mlx")}</option>
            <option value="cuda">{t("finetuningview.cuda")}</option>
          </select>
          <Input
            className="px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
            value={startModel}
            onChange={(event) => setStartModel(event.target.value)}
            placeholder={t("finetuningview.BaseModelOptional")}
          />
          <Input
            className="px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
            value={startIterations}
            onChange={(event) => setStartIterations(event.target.value)}
            placeholder={t("finetuningview.IterationsOptional")}
          />
          <Input
            className="px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
            value={startBatchSize}
            onChange={(event) => setStartBatchSize(event.target.value)}
            placeholder={t("finetuningview.BatchSizeOptional")}
          />
          <Input
            className="px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
            value={startLearningRate}
            onChange={(event) => setStartLearningRate(event.target.value)}
            placeholder={t("finetuningview.LearningRateOptio")}
          />
        </div>
        <div className="flex gap-2 mb-3">
          <Button
            variant="outline"
            size="sm"
            className="px-3 py-1 h-8 text-xs shadow-sm hover:border-accent disabled:opacity-50"
            disabled={startingJob || Boolean(activeRunningJob)}
            onClick={() => {
              void handleStartJob();
            }}
          >
            {startingJob ? "Starting..." : "Start Training Job"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="px-3 py-1 h-8 text-xs shadow-sm hover:border-accent"
            onClick={() => {
              void loadJobs();
              void loadStatus();
            }}
          >
            {t("finetuningview.RefreshJobs")}
          </Button>
          {activeRunningJob && (
            <div className="text-xs text-warn flex items-center">
              {t("finetuningview.ActiveJob")}{" "}
              <span className="font-mono ml-1">{activeRunningJob.id}</span>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="border border-border max-h-72 overflow-auto">
            {jobs.length === 0 ? (
              <div className="p-3 text-xs text-muted">
                {t("finetuningview.NoJobsYet")}
              </div>
            ) : (
              jobs.map((job) => (
                <div
                  key={job.id}
                  className={`px-2 py-2 border-b border-border text-xs ${
                    selectedJobId === job.id ? "bg-bg-hover" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      variant="link"
                      className="font-mono text-left w-auto h-auto p-0 justify-start"
                      onClick={() => setSelectedJobId(job.id)}
                    >
                      {job.id}
                    </Button>
                    {(job.status === "running" || job.status === "queued") && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="px-2 py-0.5 h-6 text-[11px] border-border hover:border-danger hover:bg-danger/10 text-danger shadow-sm disabled:opacity-50"
                        disabled={cancellingJobId === job.id}
                        onClick={() => {
                          void handleCancelJob(job.id);
                        }}
                      >
                        {cancellingJobId === job.id
                          ? "Cancelling..."
                          : "Cancel"}
                      </Button>
                    )}
                  </div>
                  <div className="text-muted mt-1">
                    {job.status} · {formatProgress(job.progress)} · {job.phase}
                  </div>
                  <div className="text-muted">{formatDate(job.createdAt)}</div>
                </div>
              ))
            )}
          </div>
          <div className="border border-border p-2">
            <div className="text-[11px] text-muted mb-2">
              {t("finetuningview.SelectedJobLogs")}
            </div>
            {!selectedJob ? (
              <div className="text-xs text-muted">
                {t("finetuningview.SelectAJobToInsp")}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs">
                  <span className="font-semibold">
                    {t("finetuningview.Status1")}
                  </span>{" "}
                  {selectedJob.status} · {formatProgress(selectedJob.progress)}{" "}
                  · {selectedJob.phase}
                </div>
                <div className="text-xs">
                  <span className="font-semibold">
                    {t("finetuningview.Dataset")}
                  </span>{" "}
                  <span className="font-mono">{selectedJob.datasetId}</span>
                </div>
                <textarea
                  readOnly
                  value={selectedJob.logs.join("\n")}
                  className="w-full min-h-56 px-2 py-1 border border-border bg-bg text-[11px] font-mono"
                />
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="border border-border bg-card p-4">
        <h3 className="text-sm font-bold mb-3">
          {t("finetuningview.TrainedModels")}
        </h3>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="border border-border max-h-72 overflow-auto">
            {models.length === 0 ? (
              <div className="p-3 text-xs text-muted">
                {t("finetuningview.NoTrainedModelsYe")}
              </div>
            ) : (
              models.map((model) => (
                <Button
                  variant="ghost"
                  key={model.id}
                  className={`w-full h-auto text-left justify-start flex-col items-start px-2 py-2 border-b border-border rounded-none text-xs ${
                    selectedModelId === model.id
                      ? "bg-bg-hover"
                      : "hover:bg-bg-hover"
                  }`}
                  onClick={() => setSelectedModelId(model.id)}
                >
                  <div className="font-mono">
                    {model.id} {model.active ? "· active" : ""}
                  </div>
                  <div className="text-muted mt-1">
                    {t("finetuningview.backend")} {model.backend}
                    {model.ollamaModel ? ` · ollama: ${model.ollamaModel}` : ""}
                  </div>
                  <div className="text-muted">
                    {t("finetuningview.benchmark")} {model.benchmark.status}
                    {model.benchmark.lastRunAt
                      ? ` · ${formatDate(model.benchmark.lastRunAt)}`
                      : ""}
                  </div>
                </Button>
              ))
            )}
          </div>
          <div className="border border-border p-2">
            <div className="text-[11px] text-muted mb-2">
              {t("finetuningview.ModelActions")}
            </div>
            {!selectedModel ? (
              <div className="text-xs text-muted">
                {t("finetuningview.SelectAModelToIm")}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs">
                  <span className="font-semibold">
                    {t("finetuningview.Model")}
                  </span>{" "}
                  <span className="font-mono">{selectedModel.id}</span>
                </div>
                <div className="text-xs">
                  <span className="font-semibold">
                    {t("finetuningview.AdapterPath")}
                  </span>{" "}
                  <span className="font-mono">
                    {selectedModel.adapterPath ?? "n/a"}
                  </span>
                </div>

                <Input
                  className="w-full px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
                  value={importModelName}
                  onChange={(event) => setImportModelName(event.target.value)}
                  placeholder={t("finetuningview.OllamaModelNameO")}
                />
                <Input
                  className="w-full px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
                  value={importBaseModel}
                  onChange={(event) => setImportBaseModel(event.target.value)}
                  placeholder={t("finetuningview.BaseModelForOllam")}
                />
                <Input
                  className="w-full px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
                  value={importOllamaUrl}
                  onChange={(event) => setImportOllamaUrl(event.target.value)}
                  placeholder={t("finetuningview.OllamaURL")}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="px-3 py-1 h-8 text-xs shadow-sm hover:border-accent disabled:opacity-50"
                  disabled={modelAction === `import:${selectedModel.id}`}
                  onClick={() => {
                    void handleImportSelectedModel();
                  }}
                >
                  {modelAction === `import:${selectedModel.id}`
                    ? "Importing..."
                    : "Import To Ollama"}
                </Button>

                <Input
                  className="w-full px-2 py-1 h-8 text-sm bg-bg border-border focus-visible:ring-accent"
                  value={activateProviderModel}
                  onChange={(event) =>
                    setActivateProviderModel(event.target.value)
                  }
                  placeholder={t("finetuningview.ProviderModelEG")}
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="px-3 py-1 h-8 text-xs shadow-sm hover:border-accent disabled:opacity-50"
                    disabled={modelAction === `activate:${selectedModel.id}`}
                    onClick={() => {
                      void handleActivateSelectedModel();
                    }}
                  >
                    {modelAction === `activate:${selectedModel.id}`
                      ? "Activating..."
                      : "Activate Model"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="px-3 py-1 h-8 text-xs shadow-sm hover:border-accent disabled:opacity-50"
                    disabled={modelAction === `benchmark:${selectedModel.id}`}
                    onClick={() => {
                      void handleBenchmarkSelectedModel();
                    }}
                  >
                    {modelAction === `benchmark:${selectedModel.id}`
                      ? "Benchmarking..."
                      : "Benchmark"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="px-3 py-1 h-8 text-xs shadow-sm hover:border-accent disabled:opacity-50"
                    disabled={modelAction === `smoke:${selectedModel.id}`}
                    onClick={() => {
                      void handleSmokeTestSelectedModel();
                    }}
                  >
                    {modelAction === `smoke:${selectedModel.id}`
                      ? "Testing..."
                      : "Run Smoke Prompt"}
                  </Button>
                </div>
                {smokeResult && (
                  <textarea
                    readOnly
                    value={smokeResult}
                    className="w-full min-h-24 px-2 py-1 border border-border bg-bg text-[11px] font-mono"
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="border border-border bg-card p-4">
        <h3 className="text-sm font-bold mb-3">
          {t("finetuningview.LiveTrainingEvents")}
        </h3>
        <div className="max-h-56 overflow-auto border border-border">
          {trainingEvents.length === 0 ? (
            <div className="p-3 text-xs text-muted">
              {t("finetuningview.NoLiveEventsYet")}
            </div>
          ) : (
            trainingEvents.map((event) => (
              <div
                key={`${event.ts}-${event.kind}-${String(event.message ?? "")}`}
                className="px-2 py-1.5 border-b border-border text-xs"
              >
                <span className="font-mono text-muted mr-2">
                  {formatTime(event.ts, { fallback: "—" })}
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
                <div className="text-muted mt-0.5">{event.message}</div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
