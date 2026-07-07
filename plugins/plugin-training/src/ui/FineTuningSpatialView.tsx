/**
 * FineTuningSpatialView — the training surface authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI - the rich `FineTuningView` is the catalog componentExport; this
 *     spatial view is the compact cross-modality summary. Only the GUI modality
 *     ships; "xr" and "tui" remain compatibility values in the manifest schema.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no shell-host UI or heavy
 * API-client import).
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

export interface FineTuningJobRow {
  id: string;
  status: string;
  phase: string;
  /** 0..1 progress fraction. */
  progress: number;
  datasetId: string;
}

export interface FineTuningSnapshot {
  runtimeAvailable: boolean;
  runningJobs: number;
  queuedJobs: number;
  completedJobs: number;
  failedJobs: number;
  jobs: FineTuningJobRow[];
  /** Trained-model count. */
  models: number;
  /** Built-dataset count. */
  datasets: number;
  /** Total trajectories available for dataset building. */
  trajectoryCount: number;
  loading?: boolean;
  error?: string | null;
}

function jobStatusTone(status: string): SpatialTone {
  switch (status) {
    case "running":
      return "primary";
    case "queued":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

function progressPct(progress: number): number {
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}

export interface FineTuningSpatialViewProps {
  snapshot: FineTuningSnapshot;
  /**
   * Dispatched action ids: `refresh`, `start-job`, `cancel-job`, and
   * `job:<id>` (open a specific job's detail).
   */
  onAction?: (action: string) => void;
}

export function FineTuningSpatialView({
  snapshot,
  onAction,
}: FineTuningSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const activeJob = snapshot.jobs.find(
    (job) => job.status === "running" || job.status === "queued",
  );
  return (
    <Card gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={snapshot.runtimeAvailable ? "success" : "danger"}
          grow={1}
        >
          {snapshot.loading
            ? "loading"
            : snapshot.runtimeAvailable
              ? "runtime-ready"
              : "runtime-offline"}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.trajectoryCount} trajectories
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <Divider label="status" />
      <HStack gap={1} wrap>
        <Text tone="primary" grow={1}>
          running {snapshot.runningJobs}
        </Text>
        <Text tone="warning" grow={1}>
          queued {snapshot.queuedJobs}
        </Text>
      </HStack>
      <HStack gap={1} wrap>
        <Text tone="success" grow={1}>
          completed {snapshot.completedJobs}
        </Text>
        <Text tone="danger" grow={1}>
          failed {snapshot.failedJobs}
        </Text>
      </HStack>
      <HStack gap={1} wrap>
        <Text tone="muted" grow={1}>
          {snapshot.models} models
        </Text>
        <Text tone="muted" grow={1}>
          {snapshot.datasets} datasets
        </Text>
      </HStack>

      <Divider label="active" />
      {activeJob ? (
        <VStack gap={0}>
          <Text bold wrap={false}>
            {activeJob.id}
          </Text>
          <Text style="caption" tone={jobStatusTone(activeJob.status)}>
            {activeJob.status} • {activeJob.phase} •{" "}
            {progressPct(activeJob.progress)}%
          </Text>
        </VStack>
      ) : (
        <Text tone="muted" align="center" style="caption">
          None
        </Text>
      )}

      <Divider label="controls" />
      <HStack gap={1} wrap>
        <Button
          variant="outline"
          tone="default"
          grow={1}
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
        <Button grow={1} agent="start-job" onPress={dispatch("start-job")}>
          Start job
        </Button>
        <Button
          variant="ghost"
          tone="danger"
          grow={1}
          agent="cancel-job"
          onPress={dispatch("cancel-job")}
        >
          Cancel job
        </Button>
      </HStack>

      <Divider label="jobs" />
      {snapshot.jobs.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          None
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.jobs.slice(0, 8).map((job) => (
            <HStack key={job.id} gap={1} align="center" agent={`row:${job.id}`}>
              <Text tone={jobStatusTone(job.status)}>
                {job.status === "completed" ? "●" : "○"}
              </Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {job.id}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {job.phase} {progressPct(job.progress)}%
                </Text>
              </VStack>
              <Text style="caption" tone={jobStatusTone(job.status)}>
                {job.status}
              </Text>
              <Button
                variant="ghost"
                tone="primary"
                agent={`open:${job.id}`}
                onPress={dispatch(`job:${job.id}`)}
              >
                Open
              </Button>
            </HStack>
          ))}
        </List>
      )}
    </Card>
  );
}

export default FineTuningSpatialView;
