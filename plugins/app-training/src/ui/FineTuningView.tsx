import {
  Button,
  client,
  confirmDesktopAction,
  ContentLayout,
  parsePositiveFloat,
  parsePositiveInteger,
  type StartTrainingOptions,
  type StreamEventEnvelope,
  type TrainingDatasetRecord,
  type TrainingJobRecord,
  type TrainingModelRecord,
  type TrainingStatus,
  type TrainingStreamEvent,
  type TrainingTrajectoryDetail,
  type TrainingTrajectoryList,
  useApp,
  useIntervalWhenDocumentVisible,
} from "@elizaos/ui";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  asTrainingEvent,
  DatasetSection,
  FINE_TUNING_ACTION_CLASS,
  FINE_TUNING_SECTION_CLASS,
  FINE_TUNING_SECTION_HEADER_CLASS,
  FINE_TUNING_SECTION_KICKER_CLASS,
  FINE_TUNING_STATUS_CARD_CLASS,
  LiveEventsPanel,
  TrainedModelsSection,
  TrainingJobsSection,
  TrajectoriesSection,
} from "./fine-tuning-panels";

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function FineTuningView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
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
  const [publishingTrajectories, setPublishingTrajectories] = useState(false);
  const [publishConfigured, setPublishConfigured] = useState(true);

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

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );
  const activeRunningJob = useMemo(
    () =>
      jobs.find((job) => job.status === "running" || job.status === "queued") ??
      null,
    [jobs],
  );

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
    const nextDatasets = asArray(listed.datasets);
    setDatasets(nextDatasets);
    setSelectedDatasetId((prev) => {
      if (prev && nextDatasets.some((dataset) => dataset.id === prev)) {
        return prev;
      }
      return nextDatasets[0]?.id ?? "";
    });
  }, []);

  const loadJobs = useCallback(async () => {
    const listed = await client.listTrainingJobs();
    const nextJobs = asArray(listed.jobs);
    setJobs(nextJobs);
    setSelectedJobId((prev) => {
      if (prev && nextJobs.some((job) => job.id === prev)) return prev;
      return nextJobs[0]?.id ?? "";
    });
  }, []);

  const loadModels = useCallback(async () => {
    const listed = await client.listTrainingModels();
    const nextModels = asArray(listed.models);
    setModels(nextModels);
    setSelectedModelId((prev) => {
      if (prev && nextModels.some((model) => model.id === prev)) return prev;
      return nextModels[0]?.id ?? "";
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
          : t("finetuningview.FailedToRefreshState"),
      );
    } finally {
      setPageLoading(false);
    }
  }, [loadDatasets, loadJobs, loadModels, loadStatus, loadTrajectories, t]);

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
            : t("finetuningview.FailedToLoadTrajectoryDetail");
        setActionNotice(message, "error", 4200);
      } finally {
        setTrajectoryLoading(false);
      }
    },
    [setActionNotice, t],
  );

  const handlePublishTrajectories = useCallback(async () => {
    setPublishingTrajectories(true);
    try {
      const response = await fetch("/api/training/trajectories/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (response.status === 409) {
        setPublishConfigured(false);
        const detail = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionNotice(
          detail?.error ??
            t("finetuningview.HuggingFacePublishNotConfigured"),
          "error",
          5200,
        );
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        trajectoriesPublished?: number;
        cloudUpload?: { huggingFaceRepo?: string; huggingFacePath?: string };
      } | null;
      if (!response.ok) {
        setActionNotice(
          payload?.error ?? t("finetuningview.FailedToPublishTrajectories"),
          "error",
          5200,
        );
        return;
      }
      setPublishConfigured(true);
      setActionNotice(
        t("finetuningview.PublishedTrajectoriesMessage", {
          count: payload?.trajectoriesPublished ?? 0,
          repo: payload?.cloudUpload?.huggingFaceRepo ?? "",
        }),
        "success",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToPublishTrajectories"),
        "error",
        5200,
      );
    } finally {
      setPublishingTrajectories(false);
    }
  }, [setActionNotice, t]);

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
        t("finetuningview.BuiltDatasetMessage", {
          id: result.dataset.id,
          count: result.dataset.sampleCount,
        }),
        "success",
        3800,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToBuildDataset"),
        "error",
        4200,
      );
    } finally {
      setDatasetBuilding(false);
    }
  }, [buildLimit, buildMinCalls, loadDatasets, loadStatus, setActionNotice, t]);

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
        t("finetuningview.StartedTrainingJobMessage", { id: result.job.id }),
        "success",
        3200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToStartTrainingJob"),
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
    t,
  ]);

  const handleCancelJob = useCallback(
    async (jobId: string) => {
      setCancellingJobId(jobId);
      try {
        await client.cancelTrainingJob(jobId);
        await Promise.all([loadJobs(), loadStatus()]);
        setActionNotice(
          t("finetuningview.CancelledJobMessage", { id: jobId }),
          "success",
          2600,
        );
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : t("finetuningview.FailedToCancelJob", { id: jobId }),
          "error",
          4200,
        );
      } finally {
        setCancellingJobId("");
      }
    },
    [loadJobs, loadStatus, setActionNotice, t],
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
        t("finetuningview.ImportedModelToOllamaMessage", {
          id: result.model.id,
          ollamaModel: result.model.ollamaModel
            ? ` as ${result.model.ollamaModel}`
            : "",
        }),
        "success",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToImportModelToOllama"),
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
    t,
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
        t("finetuningview.ActivatedModelMessage", {
          id: result.modelId,
          providerModel: result.providerModel,
        }),
        "success",
        4200,
      );
      if (result.needsRestart) {
        const shouldRestart = await confirmDesktopAction({
          title: t("finetuningview.RestartAgentTitle"),
          message: t("finetuningview.RestartAgentMessage"),
          confirmLabel: t("finetuningview.Restart"),
          cancelLabel: t("restartbanner.Later"),
          type: "question",
        });
        if (shouldRestart) {
          await handleRestart();
        }
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToActivateModel"),
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
    t,
  ]);

  const handleBenchmarkSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `benchmark:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.benchmarkTrainingModel(selectedModel.id);
      await loadModels();
      setActionNotice(
        t("finetuningview.BenchmarkStatusMessage", {
          status: result.status,
          id: selectedModel.id,
        }),
        result.status === "passed" ? "success" : "error",
        4200,
      );
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToBenchmarkModel"),
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [loadModels, selectedModel, setActionNotice, t]);

  const handleSmokeTestSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    const actionId = `smoke:${selectedModel.id}`;
    setModelAction(actionId);
    try {
      const result = await client.sendChatRest(
        "Model smoke test. Reply with exactly: MODEL_OK",
      );
      setSmokeResult(result.text);
      setActionNotice(t("finetuningview.SmokeTestCompleted"), "success", 3200);
    } catch (err) {
      setSmokeResult(null);
      setActionNotice(
        err instanceof Error
          ? err.message
          : t("finetuningview.FailedToRunSmokeTest"),
        "error",
        4200,
      );
    } finally {
      setModelAction("");
    }
  }, [selectedModel, setActionNotice, t]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useIntervalWhenDocumentVisible(() => {
    void loadStatus();
    void loadJobs();
    void loadModels();
  }, 5000);

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
      <ContentLayout contentHeader={contentHeader}>
        <div data-testid="fine-tuning-view" className="text-sm text-muted">
          {t("finetuningview.LoadingFineTuning")}
        </div>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout contentHeader={contentHeader}>
      <div data-testid="fine-tuning-view" className="space-y-6 pb-8">
        <section className={FINE_TUNING_SECTION_CLASS}>
          <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
            <div className="space-y-2">
              <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
                {t("finetuningview.FineTuning")}
              </div>
              <h2 className="text-xl font-semibold text-txt">
                {t("finetuningview.FineTuning")}
              </h2>
              <p className="max-w-2xl text-sm leading-relaxed text-muted">
                {t("finetuningview.BuildDatasetsFrom")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className={FINE_TUNING_ACTION_CLASS}
              onClick={() => {
                void refreshAll();
              }}
            >
              {t("finetuningview.RefreshAll")}
            </Button>
          </div>
          {errorMessage && (
            <div className="mt-3 rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
              {errorMessage}
            </div>
          )}
        </section>

        <section className={FINE_TUNING_SECTION_CLASS}>
          <div className={FINE_TUNING_SECTION_HEADER_CLASS}>
            <div className="space-y-1">
              <div className={FINE_TUNING_SECTION_KICKER_CLASS}>
                {t("finetuningview.Overview")}
              </div>
              <div className="text-lg font-semibold text-txt">
                {t("finetuningview.Status")}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3 xl:grid-cols-6">
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.Runtime")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.runtimeAvailable
                  ? t("finetuningview.Ready")
                  : t("finetuningview.Offline")}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.RunningJobs")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.runningJobs ?? 0}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.QueuedJobs")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.queuedJobs ?? 0}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.Datasets")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.datasetCount ?? 0}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.Models")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.modelCount ?? 0}
              </div>
            </div>
            <div className={FINE_TUNING_STATUS_CARD_CLASS}>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                {t("finetuningview.FailedJobs")}
              </div>
              <div className="mt-2 text-base font-semibold text-txt">
                {status?.failedJobs ?? 0}
              </div>
            </div>
          </div>
        </section>

        <TrajectoriesSection
          trajectoryList={trajectoryList}
          selectedTrajectory={selectedTrajectory}
          trajectoryLoading={trajectoryLoading}
          publishingTrajectories={publishingTrajectories}
          publishConfigured={publishConfigured}
          onRefresh={() => {
            void loadTrajectories();
          }}
          onSelectTrajectory={(trajectoryId) => {
            void loadTrajectoryDetail(trajectoryId);
          }}
          onPublishTrajectories={() => {
            void handlePublishTrajectories();
          }}
          t={t}
        />

        <DatasetSection
          buildLimit={buildLimit}
          setBuildLimit={setBuildLimit}
          buildMinCalls={buildMinCalls}
          setBuildMinCalls={setBuildMinCalls}
          datasetBuilding={datasetBuilding}
          onBuildDataset={() => {
            void handleBuildDataset();
          }}
          onRefreshDatasets={() => {
            void loadDatasets();
          }}
          datasets={datasets}
          selectedDatasetId={selectedDatasetId}
          setSelectedDatasetId={setSelectedDatasetId}
          t={t}
        />

        <TrainingJobsSection
          selectedDatasetId={selectedDatasetId}
          setSelectedDatasetId={setSelectedDatasetId}
          datasets={datasets}
          startBackend={startBackend}
          setStartBackend={setStartBackend}
          startModel={startModel}
          setStartModel={setStartModel}
          startIterations={startIterations}
          setStartIterations={setStartIterations}
          startBatchSize={startBatchSize}
          setStartBatchSize={setStartBatchSize}
          startLearningRate={startLearningRate}
          setStartLearningRate={setStartLearningRate}
          startingJob={startingJob}
          activeRunningJob={activeRunningJob}
          onStartJob={() => {
            void handleStartJob();
          }}
          onRefreshJobs={() => {
            void loadJobs();
            void loadStatus();
          }}
          jobs={jobs}
          selectedJobId={selectedJobId}
          setSelectedJobId={setSelectedJobId}
          cancellingJobId={cancellingJobId}
          onCancelJob={(jobId) => {
            void handleCancelJob(jobId);
          }}
          selectedJob={selectedJob}
          t={t}
        />

        <TrainedModelsSection
          models={models}
          selectedModelId={selectedModelId}
          setSelectedModelId={setSelectedModelId}
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
          onImport={() => {
            void handleImportSelectedModel();
          }}
          onActivate={() => {
            void handleActivateSelectedModel();
          }}
          onBenchmark={() => {
            void handleBenchmarkSelectedModel();
          }}
          onSmokeTest={() => {
            void handleSmokeTestSelectedModel();
          }}
          t={t}
        />

        <LiveEventsPanel events={trainingEvents} t={t} />
      </div>
    </ContentLayout>
  );
}
