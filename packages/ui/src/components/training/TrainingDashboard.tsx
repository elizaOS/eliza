import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Loader2, Plus } from "lucide-react";
import { useCallback, useState } from "react";
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
  if (error) {
    return (
      <div className="border border-border rounded p-4 bg-red-500/10">
        <div className="text-sm text-red-500">{error}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="border border-border rounded p-4 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading jobs...</span>
      </div>
    );
  }

  if (!jobs || jobs.length === 0) {
    return (
      <div className="border border-border rounded p-4 text-center">
        <div className="text-sm text-muted">No training jobs</div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Job
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Status
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Step
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Format
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Content
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Started
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
                  {job.last_format_ok ? "Yes" : "No"}
                </div>
              </td>
              <td className="px-3 py-2">
                <div
                  className={`text-xs font-semibold ${
                    job.last_content_ok ? "text-green-500" : "text-red-500"
                  }`}
                >
                  {job.last_content_ok ? "Yes" : "No"}
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
  if (error) {
    return (
      <div className="border border-border rounded p-4 bg-red-500/10">
        <div className="text-sm text-red-500">{error}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="border border-border rounded p-4 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading models...</span>
      </div>
    );
  }

  if (!models || models.length === 0) {
    return (
      <div className="border border-border rounded p-4 text-center">
        <div className="text-sm text-muted">No models available</div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Model
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Tier
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Context
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-muted-strong uppercase tracking-wide">
              GPU
            </th>
            <th className="px-3 py-2 text-center text-xs font-semibold text-muted-strong uppercase tracking-wide">
              Action
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
                  Train
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
      setCreateError("Epochs must be a positive number");
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
        err instanceof Error ? err.message : "Failed to create job",
      );
    }
  }, [createModal, create]);

  return (
    <div className="space-y-6 p-4">
      {/* Active Jobs Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-txt-strong">
              Active Training Jobs
            </h2>
            <p className="text-xs text-muted">Updates every 10 seconds</p>
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
              Available Models
            </h2>
            <p className="text-xs text-muted">Click Train to create a job</p>
          </div>
        </div>
        <ModelsTable
          models={models}
          loading={modelsLoading}
          error={modelsError}
          onTrainClick={handleTrainClick}
        />

        {createModal.open && createModal.model && (
          <div className="border border-border rounded p-4 bg-card space-y-3">
            <div className="text-sm font-semibold">
              Train {createModal.model.short_name}
            </div>
            {createError && (
              <div className="text-xs text-red-500 bg-red-500/10 p-2 rounded">
                {createError}
              </div>
            )}
            <div>
              <label
                className="text-xs text-muted block mb-1"
                htmlFor="training-epochs"
              >
                Epochs
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
                Run Name (optional)
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
                placeholder="e.g., experiment-v2"
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
                Start Training
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
                Cancel
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
              Inference Endpoints
            </h2>
            <p className="text-xs text-muted">Manage and monitor endpoints</p>
          </div>
        </div>
        <InferenceEndpointPanel />
      </section>
    </div>
  );
}
