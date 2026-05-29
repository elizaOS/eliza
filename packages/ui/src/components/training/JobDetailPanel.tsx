import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../state/TranslationContext";
import { Button } from "../ui/button";
import { BudgetPanel } from "./BudgetPanel";
import {
  useCancelTrainingJob,
  useEvalTrainingJob,
  useJobLogs,
  useTrainingJobDetail,
} from "./hooks/useTrainingApi";

interface JobDetailPanelProps {
  jobId: string;
  onClose: () => void;
}

function ProgressChart({
  data,
}: {
  data: Array<{ step: number; format_ok: boolean; content_ok: boolean }>;
}) {
  const { t } = useTranslation();
  if (!data || data.length === 0) {
    return (
      <div className="text-xs text-muted">
        {t("jobdetail.noProgressData", { defaultValue: "No progress data" })}
      </div>
    );
  }

  const width = 400;
  const height = 120;
  const padding = 40;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding;

  const points = data.map((d, i) => ({
    step: d.step,
    x: padding + (i / Math.max(data.length - 1, 1)) * chartWidth,
    y: padding + chartHeight / 2,
    formatOk: d.format_ok,
    contentOk: d.content_ok,
  }));

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-labelledby="training-progress-title"
      className="border border-border rounded-sm bg-card"
    >
      <title id="training-progress-title">
        {t("jobdetail.chart.title", { defaultValue: "Training progress" })}
      </title>
      <text x={10} y={20} fontSize="12" fill="currentColor">
        {t("jobdetail.chart.heading", { defaultValue: "Training Progress" })}
      </text>

      <line
        x1={padding}
        y1={padding + chartHeight / 2}
        x2={width - padding}
        y2={padding + chartHeight / 2}
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.2"
      />

      {points.map((point) => (
        <g key={`${point.step}-${point.formatOk}-${point.contentOk}`}>
          <circle
            cx={point.x}
            cy={point.y - 15}
            r={point.formatOk ? 4 : 2}
            fill={point.formatOk ? "#10b981" : "#6b7280"}
          />
          <circle
            cx={point.x}
            cy={point.y + 15}
            r={point.contentOk ? 4 : 2}
            fill={point.contentOk ? "#3b82f6" : "#6b7280"}
          />
        </g>
      ))}

      <text x={width - 35} y={padding - 5} fontSize="10" fill="currentColor">
        {t("jobdetail.chart.formatOk", { defaultValue: "Format OK" })}
      </text>
      <text
        x={width - 35}
        y={padding + chartHeight + 15}
        fontSize="10"
        fill="currentColor"
      >
        {t("jobdetail.chart.contentOk", { defaultValue: "Content OK" })}
      </text>
    </svg>
  );
}

function CheckpointsList({
  checkpoints,
}: {
  checkpoints: Array<{ step: number; pulled_at: string; size_mb: number }>;
}) {
  const { t } = useTranslation();
  if (!checkpoints || checkpoints.length === 0) {
    return (
      <div className="text-xs text-muted">
        {t("jobdetail.noCheckpoints", { defaultValue: "No checkpoints" })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {checkpoints.map((cp) => (
        <div
          key={cp.step}
          className="text-xs border border-border rounded-sm p-2"
        >
          <div className="font-mono text-txt-strong">
            {t("jobdetail.step", {
              step: cp.step,
              defaultValue: "Step {{step}}",
            })}
          </div>
          <div className="text-muted">
            {cp.size_mb.toFixed(1)} MB ·{" "}
            {new Date(cp.pulled_at).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}

function JobLogs({ jobId }: { jobId: string }) {
  const { t } = useTranslation();
  const { data: logs, loading, error } = useJobLogs(jobId);
  const [showLogs, setShowLogs] = useState(false);

  if (!showLogs) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowLogs(true)}
        className="w-full"
      >
        <ChevronDown className="w-4 h-4" />
        {t("jobdetail.showLogs", { defaultValue: "Show Logs" })}
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowLogs(false)}
        className="w-full"
      >
        <ChevronUp className="w-4 h-4" />
        {t("jobdetail.hideLogs", { defaultValue: "Hide Logs" })}
      </Button>
      {error && <div className="text-xs text-red-500">{error}</div>}
      {loading && (
        <div className="text-xs text-muted">
          {t("jobdetail.loadingLogs", { defaultValue: "Loading logs..." })}
        </div>
      )}
      {logs && (
        <div className="text-xs bg-card border border-border rounded-sm p-2 font-mono max-h-48 overflow-auto">
          {logs.map((line) => (
            <div key={line} className="text-muted">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function JobDetailPanel({ jobId, onClose }: JobDetailPanelProps) {
  const { t } = useTranslation();
  const { data: job, loading, error } = useTrainingJobDetail(jobId);
  const { cancel, loading: cancelLoading } = useCancelTrainingJob();
  const { eval: evalJob, loading: evalLoading } = useEvalTrainingJob();
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCancel = useCallback(async () => {
    setActionError(null);
    try {
      await cancel(jobId);
      onClose();
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : t("jobdetail.error.cancelFailed", {
              defaultValue: "Failed to cancel job",
            }),
      );
    }
  }, [jobId, cancel, onClose, t]);

  const handleEval = useCallback(async () => {
    setActionError(null);
    try {
      await evalJob(jobId);
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : t("jobdetail.error.evalFailed", {
              defaultValue: "Failed to trigger eval",
            }),
      );
    }
  }, [jobId, evalJob, t]);

  const progressData = useMemo(() => {
    if (!job?.progress) return [];
    return job.progress.slice(0, 200);
  }, [job?.progress]);

  if (loading) {
    return (
      <div className="p-4 space-y-4 border border-border rounded-sm">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">
            {t("jobdetail.loading", { defaultValue: "Loading job details..." })}
          </span>
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="p-4 border border-border rounded-sm bg-red-500/10">
        <div className="text-sm text-red-500">
          {error ||
            t("jobdetail.error.loadFailed", {
              defaultValue: "Failed to load job details",
            })}
        </div>
        <Button variant="outline" size="sm" onClick={onClose} className="mt-2">
          {t("jobdetail.close", { defaultValue: "Close" })}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 border border-border rounded-sm p-4 bg-card">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs text-muted uppercase tracking-wide">
              {t("jobdetail.field.status", { defaultValue: "Status" })}
            </div>
            <div className="text-sm font-semibold text-txt-strong">
              {job.status}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-muted"
          >
            ×
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-muted">
              {t("jobdetail.field.registryKey", {
                defaultValue: "Registry Key",
              })}
            </div>
            <div className="font-mono text-txt break-all">
              {job.registry_key}
            </div>
          </div>
          <div>
            <div className="text-muted">
              {t("jobdetail.field.started", { defaultValue: "Started" })}
            </div>
            <div className="text-txt">
              {new Date(job.started_at).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-muted">
              {t("jobdetail.field.step", { defaultValue: "Step" })}
            </div>
            <div className="text-txt font-semibold">{job.last_step}</div>
          </div>
          <div>
            <div className="text-muted">
              {t("jobdetail.field.formatOk", { defaultValue: "Format OK" })}
            </div>
            <div
              className={job.last_format_ok ? "text-green-500" : "text-red-500"}
            >
              {job.last_format_ok
                ? t("jobdetail.yes", { defaultValue: "Yes" })
                : t("jobdetail.no", { defaultValue: "No" })}
            </div>
          </div>
        </div>
      </div>

      {actionError && (
        <div className="text-xs text-red-500 bg-red-500/10 p-2 rounded-sm">
          {actionError}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleEval}
          disabled={evalLoading}
          className="flex-1"
        >
          {evalLoading && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
          {t("jobdetail.triggerEval", { defaultValue: "Trigger Eval" })}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={handleCancel}
          disabled={cancelLoading}
          className="flex-1"
        >
          {cancelLoading && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
          {t("jobdetail.cancel", { defaultValue: "Cancel" })}
        </Button>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-txt-strong">
          {t("jobdetail.runningCost", { defaultValue: "Running Cost" })}
        </div>
        <BudgetPanel jobId={jobId} />
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-txt-strong">
          {t("jobdetail.progressChart", { defaultValue: "Progress Chart" })}
        </div>
        <ProgressChart data={progressData} />
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-txt-strong">
          {t("jobdetail.checkpoints", { defaultValue: "Checkpoints" })}
        </div>
        <CheckpointsList checkpoints={job.checkpoints} />
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-txt-strong">
          {t("jobdetail.logs", { defaultValue: "Logs" })}
        </div>
        <JobLogs jobId={jobId} />
      </div>
    </div>
  );
}
