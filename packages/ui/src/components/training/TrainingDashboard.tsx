import { Loader2, Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "../../state/TranslationContext";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  useCreateTrainingJob,
  useTrainingJobs,
  useTrainingModels,
} from "./hooks/useTrainingApi";
import { InferenceEndpointPanel } from "./InferenceEndpointPanel";
import { JobDetailPanel } from "./JobDetailPanel";
import type { TrainingJob, TrainingModel } from "./types";

interface CreateModalState {
  open: boolean;
  model: TrainingModel | null;
  epochs: string;
  runName: string;
}

function JobsTable({
  jobs,
  loading,
  error,
  onRowClick,
}: {
  jobs: TrainingJob[] | null;
  loading: boolean;
  error: string | null;
  onRowClick: (jobId: string) => void;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="border border-border rounded-sm p-4 bg-red-500/10">
        <div className="text-sm text-red-500">{error}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="border border-border rounded-sm p-4 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">
          {t("trainingdashboard.jobs.loading", {
            defaultValue: "Loading jobs...",
          })}
        </span>
      </div>
    );
  }

  if (!jobs || jobs.length === 0) {
    return (
      <div className="border border-border rounded-sm p-4 text-center">
        <div className="text-sm text-muted">
          {t("trainingdashboard.jobs.empty", {
            defaultValue: "No training jobs",
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.jobs.col.job", { defaultValue: "Job" })}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.jobs.col.status", {
                defaultValue: "Status",
              })}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.jobs.col.step", { defaultValue: "Step" })}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.jobs.col.format", {
                defaultValue: "Format",
              })}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.jobs.col.content", {
                defaultValue: "Content",
              })}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.jobs.col.started", {
                defaultValue: "Started",
              })}
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job: TrainingJob) => (
            <tr
              key={job.id}
              onClick={() => onRowClick(job.id)}
              className="border-b border-border hover:bg-card/50 cursor-pointer transition-colors"
            >
              <td className="px-3 py-2">
                <div className="font-mono text-xs text-accent">{job.id}</div>
                <div className="text-xs text-muted">{job.run_name}</div>
              </td>
              <td className="px-3 py-2">
                <div className="text-xs font-semibold">{job.status}</div>
              </td>
              <td className="px-3 py-2">
                <div className="text-xs text-txt">{job.last_step}</div>
              </td>
              <td className="px-3 py-2">
                <div
                  className={`text-xs font-semibold ${
                    job.last_format_ok ? "text-green-500" : "text-red-500"
                  }`}
                >
                  {job.last_format_ok
                    ? t("trainingdashboard.yes", { defaultValue: "Yes" })
                    : t("trainingdashboard.no", { defaultValue: "No" })}
                </div>
              </td>
              <td className="px-3 py-2">
                <div
                  className={`text-xs font-semibold ${
                    job.last_content_ok ? "text-green-500" : "text-red-500"
                  }`}
                >
                  {job.last_content_ok
                    ? t("trainingdashboard.yes", { defaultValue: "Yes" })
                    : t("trainingdashboard.no", { defaultValue: "No" })}
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="text-xs text-muted">
                  {new Date(job.started_at).toLocaleString()}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelsTable({
  models,
  loading,
  error,
  onTrainClick,
}: {
  models: TrainingModel[] | null;
  loading: boolean;
  error: string | null;
  onTrainClick: (model: TrainingModel) => void;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="border border-border rounded-sm p-4 bg-red-500/10">
        <div className="text-sm text-red-500">{error}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="border border-border rounded-sm p-4 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">
          {t("trainingdashboard.models.loading", {
            defaultValue: "Loading models...",
          })}
        </span>
      </div>
    );
  }

  if (!models || models.length === 0) {
    return (
      <div className="border border-border rounded-sm p-4 text-center">
        <div className="text-sm text-muted">
          {t("trainingdashboard.models.empty", {
            defaultValue: "No models available",
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.models.col.model", {
                defaultValue: "Model",
              })}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.models.col.tier", { defaultValue: "Tier" })}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.models.col.context", {
                defaultValue: "Context",
              })}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.models.col.gpu", { defaultValue: "GPU" })}
            </th>
            <th className="px-3 py-2 text-center text-xs font-semibold text-muted-strong uppercase tracking-wide">
              {t("trainingdashboard.models.col.action", {
                defaultValue: "Action",
              })}
            </th>
          </tr>
        </thead>
        <tbody>
          {models.map((model: TrainingModel) => (
            <tr
              key={model.short_name}
              className="border-b border-border hover:bg-card/50"
            >
              <td className="px-3 py-2">
                <div className="font-semibold text-txt-strong">
                  {model.short_name}
                </div>
                <div className="text-xs text-muted font-mono">
                  {model.base_repo_id}
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="text-xs text-txt">{model.tier}</div>
              </td>
              <td className="px-3 py-2">
                <div className="text-xs text-txt">{model.max_context}k</div>
              </td>
              <td className="px-3 py-2">
                <div className="text-xs text-muted">
                  {model.recommended_gpu}
                </div>
              </td>
              <td className="px-3 py-2 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onTrainClick(model)}
                >
                  <Plus className="w-4 h-4" />
                  {t("trainingdashboard.train", { defaultValue: "Train" })}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TrainingDashboard() {
  const { t } = useTranslation();
  const {
    data: jobs,
    loading: jobsLoading,
    error: jobsError,
  } = useTrainingJobs();
  const {
    data: models,
    loading: modelsLoading,
    error: modelsError,
  } = useTrainingModels();
  const { create, loading: createLoading } = useCreateTrainingJob();

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [createModal, setCreateModal] = useState<CreateModalState>({
    open: false,
    model: null,
    epochs: "3",
    runName: "",
  });
  const [createError, setCreateError] = useState<string | null>(null);

  const handleTrainClick = useCallback((model: TrainingModel) => {
    setCreateModal({
      open: true,
      model,
      epochs: "3",
      runName: "",
    });
    setCreateError(null);
  }, []);

  const handleCreateJob = useCallback(async () => {
    if (!createModal.model) return;
    setCreateError(null);

    const epochs = parseInt(createModal.epochs, 10);
    if (Number.isNaN(epochs) || epochs < 1) {
      setCreateError(
        t("trainingdashboard.error.epochsPositive", {
          defaultValue: "Epochs must be a positive number",
        }),
      );
      return;
    }

    try {
      await create({
        registry_key: createModal.model.short_name,
        epochs,
        run_name: createModal.runName || undefined,
      });
      setCreateModal({ open: false, model: null, epochs: "3", runName: "" });
    } catch (err) {
      setCreateError(
        err instanceof Error
          ? err.message
          : t("trainingdashboard.error.createFailed", {
              defaultValue: "Failed to create job",
            }),
      );
    }
  }, [createModal, create, t]);

  return (
    <div className="space-y-6 p-4">
      {/* Active Jobs Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-txt-strong">
              {t("trainingdashboard.activeJobs.title", {
                defaultValue: "Active Training Jobs",
              })}
            </h2>
            <p className="text-xs text-muted">
              {t("trainingdashboard.activeJobs.subtitle", {
                defaultValue: "Updates every 10 seconds",
              })}
            </p>
          </div>
        </div>
        <JobsTable
          jobs={jobs}
          loading={jobsLoading}
          error={jobsError}
          onRowClick={setSelectedJobId}
        />
        {selectedJobId && (
          <JobDetailPanel
            jobId={selectedJobId}
            onClose={() => setSelectedJobId(null)}
          />
        )}
      </section>

      {/* Models Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-txt-strong">
              {t("trainingdashboard.availableModels.title", {
                defaultValue: "Available Models",
              })}
            </h2>
            <p className="text-xs text-muted">
              {t("trainingdashboard.availableModels.subtitle", {
                defaultValue: "Click Train to create a job",
              })}
            </p>
          </div>
        </div>
        <ModelsTable
          models={models}
          loading={modelsLoading}
          error={modelsError}
          onTrainClick={handleTrainClick}
        />

        {createModal.open && createModal.model && (
          <div className="border border-border rounded-sm p-4 bg-card space-y-3">
            <div className="text-sm font-semibold">
              {t("trainingdashboard.modal.trainModel", {
                model: createModal.model.short_name,
                defaultValue: "Train {{model}}",
              })}
            </div>
            {createError && (
              <div className="text-xs text-red-500 bg-red-500/10 p-2 rounded-sm">
                {createError}
              </div>
            )}
            <div>
              <label
                className="text-xs text-muted block mb-1"
                htmlFor="training-epochs"
              >
                {t("trainingdashboard.modal.epochs", {
                  defaultValue: "Epochs",
                })}
              </label>
              <Input
                id="training-epochs"
                type="number"
                min="1"
                value={createModal.epochs}
                onChange={(e) =>
                  setCreateModal({
                    ...createModal,
                    epochs: e.target.value,
                  })
                }
                className="text-sm"
              />
            </div>
            <div>
              <label
                className="text-xs text-muted block mb-1"
                htmlFor="training-run-name"
              >
                {t("trainingdashboard.modal.runName", {
                  defaultValue: "Run Name (optional)",
                })}
              </label>
              <Input
                id="training-run-name"
                type="text"
                value={createModal.runName}
                onChange={(e) =>
                  setCreateModal({
                    ...createModal,
                    runName: e.target.value,
                  })
                }
                placeholder={t("trainingdashboard.modal.runNamePlaceholder", {
                  defaultValue: "e.g., experiment-v2",
                })}
                className="text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="default"
                size="sm"
                onClick={handleCreateJob}
                disabled={createLoading}
                className="flex-1"
              >
                {createLoading && (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                )}
                {t("trainingdashboard.modal.start", {
                  defaultValue: "Start Training",
                })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCreateModal({
                    open: false,
                    model: null,
                    epochs: "3",
                    runName: "",
                  })
                }
                className="flex-1"
              >
                {t("trainingdashboard.modal.cancel", {
                  defaultValue: "Cancel",
                })}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Inference Endpoints Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-txt-strong">
              {t("trainingdashboard.endpoints.title", {
                defaultValue: "Inference Endpoints",
              })}
            </h2>
            <p className="text-xs text-muted">
              {t("trainingdashboard.endpoints.subtitle", {
                defaultValue: "Manage and monitor endpoints",
              })}
            </p>
          </div>
        </div>
        <InferenceEndpointPanel />
      </section>
    </div>
  );
}
