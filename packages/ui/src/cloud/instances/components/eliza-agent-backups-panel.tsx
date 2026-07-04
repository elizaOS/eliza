"use client";

/**
 * Backups panel for a cloud agent instance: lists snapshots with sizes/ages and
 * restore actions.
 */
import { formatByteSize } from "@elizaos/shared/utils/format";
import { Badge, BrandButton, BrandCard, Skeleton } from "@elizaos/ui/cloud-ui";
import { formatDistanceToNowStrict } from "date-fns";
import {
  AlertTriangle,
  DatabaseBackup,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface ElizaAgentBackupsPanelProps {
  agentId: string;
  agentName: string;
  status: string;
}

interface BackupRecord {
  id: string;
  snapshotType: "auto" | "manual" | "pre-shutdown";
  sizeBytes: number | null;
  createdAt: string;
}

interface BackupsApiResponse {
  success?: boolean;
  error?: string;
  data?: BackupRecord[];
}

const SNAPSHOT_TYPE_LABELS: Record<BackupRecord["snapshotType"], string> = {
  auto: "Auto",
  manual: "Manual",
  "pre-shutdown": "Pre-shutdown",
};

const SNAPSHOT_TYPE_STYLES: Record<BackupRecord["snapshotType"], string> = {
  auto: "border-border bg-bg-muted text-muted-strong",
  manual: "border-accent/40 bg-accent-subtle text-accent",
  "pre-shutdown": "border-border-strong bg-surface text-txt-strong",
};

function formatTimestamp(value: string): {
  absolute: string;
  relative: string;
} {
  const date = new Date(value);
  return {
    absolute: date.toLocaleString(),
    relative: formatDistanceToNowStrict(date, { addSuffix: true }),
  };
}

export function ElizaAgentBackupsPanel({
  agentId,
  agentName,
  status,
}: ElizaAgentBackupsPanelProps) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeRestoreTarget, setActiveRestoreTarget] = useState<string | null>(
    null,
  );

  const isRunning = status === "running";
  const isBusy = status === "provisioning";

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/eliza/agents/${agentId}/backups`, {
        cache: "no-store",
      });
      const payload: BackupsApiResponse = await response
        .json()
        .catch(() => ({}));

      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }

      setBackups(Array.isArray(payload.data) ? payload.data : []);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error ? fetchError.message : String(fetchError),
      );
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchBackups();
  }, [fetchBackups]);

  const latestBackup = useMemo(
    () =>
      backups.reduce<BackupRecord | null>((latest, backup) => {
        if (!latest) return backup;
        return new Date(backup.createdAt) > new Date(latest.createdAt)
          ? backup
          : latest;
      }, null),
    [backups],
  );
  const manualCount = useMemo(
    () => backups.filter((backup) => backup.snapshotType === "manual").length,
    [backups],
  );
  const preShutdownCount = useMemo(
    () =>
      backups.filter((backup) => backup.snapshotType === "pre-shutdown").length,
    [backups],
  );

  const restoreBackup = useCallback(
    async (backupId?: string) => {
      if (!latestBackup) {
        toast.error("No backups available to restore");
        return;
      }

      if (!isRunning && backupId && backupId !== latestBackup.id) {
        toast.error("Stopped agents can only restore the latest backup");
        return;
      }

      const targetBackupId = backupId ?? latestBackup.id;
      setActiveRestoreTarget(targetBackupId);

      try {
        const response = await fetch(
          `/api/v1/eliza/agents/${agentId}/restore`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(backupId ? { backupId } : {}),
          },
        );
        const payload = await response.json().catch(() => ({}));

        if (!response.ok || !(payload as { success?: boolean }).success) {
          throw new Error(
            (payload as { error?: string }).error ?? `HTTP ${response.status}`,
          );
        }

        toast.success(
          isRunning
            ? "Backup restored"
            : "Latest backup restored. The agent was restarted with that state.",
        );

        await fetchBackups();
        window.location.reload();
      } catch (restoreError) {
        toast.error(
          restoreError instanceof Error
            ? restoreError.message
            : String(restoreError),
        );
      } finally {
        setActiveRestoreTarget(null);
      }
    },
    [agentId, fetchBackups, isRunning, latestBackup],
  );

  return (
    <BrandCard className="relative" cornerSize="sm">
      <div className="relative z-10 space-y-6">
        <div className="flex flex-col gap-4 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-accent" />
              <h2 className="font-mono text-xl font-normal text-txt-strong">
                Backups &amp; History
              </h2>
            </div>
            <p className="text-sm text-muted-strong">
              Snapshot history and restore controls for{" "}
              {agentName || "this agent"}.
            </p>
            <p className="mt-1 text-xs text-muted">
              Use &ldquo;Save Snapshot&rdquo; above to capture the current
              running state.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <BrandButton variant="outline" size="sm" onClick={fetchBackups}>
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </BrandButton>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={() => restoreBackup()}
              disabled={!latestBackup || !!activeRestoreTarget || isBusy}
            >
              {activeRestoreTarget === latestBackup?.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              Restore latest
            </BrandButton>
          </div>
        </div>

        {!isRunning && latestBackup && (
          <div className="flex items-start gap-3 border border-status-warning/30 bg-status-warning-bg p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
            <div className="space-y-1">
              <p className="text-sm text-status-warning">
                This agent is not currently running.
              </p>
              <p className="text-xs text-status-warning/80">
                For stopped agents, restores are limited to the latest backup
                only. Historical per-row restore actions stay hidden until the
                agent is running again.
              </p>
            </div>
          </div>
        )}

        {isBusy && (
          <div className="flex items-start gap-3 border border-border-strong bg-bg-muted p-4">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-strong" />
            <p className="text-sm text-txt-strong">
              Provisioning is in progress. Wait for the agent to finish starting
              before restoring.
            </p>
          </div>
        )}

        {loading ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-24 rounded-sm" />
              <Skeleton className="h-24 rounded-sm" />
              <Skeleton className="h-24 rounded-sm" />
            </div>
            <Skeleton className="h-16 rounded-sm" />
            <Skeleton className="h-16 rounded-sm" />
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <History className="mx-auto mb-3 h-8 w-8 text-muted" />
            <p className="mb-1 text-sm text-destructive">
              Failed to load backups
            </p>
            <p className="text-xs text-muted">{error}</p>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={fetchBackups}
              className="mt-4"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </BrandButton>
          </div>
        ) : backups.length === 0 ? (
          <div className="py-10 text-center">
            <DatabaseBackup className="mx-auto mb-3 h-8 w-8 text-muted" />
            <p className="text-sm text-muted-strong">No backups yet</p>
            <p className="mt-1 text-xs text-muted">
              Run the agent and save a snapshot to create the first restore
              point.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="border border-border bg-bg-muted p-4 text-center">
                <p className="font-mono text-2xl font-medium text-txt-strong">
                  {backups.length}
                </p>
                <p className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-strong">
                  Total backups
                </p>
              </div>
              <div className="border border-border bg-bg-muted p-4 text-center">
                <p className="font-mono text-lg font-medium text-accent">
                  {manualCount}
                </p>
                <p className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-strong">
                  Manual snapshots
                </p>
              </div>
              <div className="border border-border bg-bg-muted p-4 text-center">
                <p className="font-mono text-lg font-medium text-txt-strong">
                  {preShutdownCount}
                </p>
                <p className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-strong">
                  Pre-shutdown backups
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {backups.map((backup) => {
                const timestamp = formatTimestamp(backup.createdAt);
                const isLatest = backup.id === latestBackup?.id;
                const isRestoring = activeRestoreTarget === backup.id;

                return (
                  <div
                    key={backup.id}
                    className="border border-border bg-card p-4 transition-colors hover:border-border-strong hover:bg-bg-hover"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {isLatest && (
                            <Badge
                              variant="outline"
                              className="border-status-success/40 bg-status-success-bg text-status-success"
                            >
                              Latest
                            </Badge>
                          )}
                          <Badge
                            variant="outline"
                            className={SNAPSHOT_TYPE_STYLES[backup.snapshotType]}
                          >
                            {SNAPSHOT_TYPE_LABELS[backup.snapshotType]}
                          </Badge>
                        </div>

                        <div>
                          <p className="font-mono text-sm font-medium text-txt-strong">
                            {timestamp.absolute}
                          </p>
                          <p className="text-xs text-muted-strong">
                            {timestamp.relative}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-4 font-mono text-xs text-muted-strong">
                          <span>
                            Size:{" "}
                            {formatByteSize(backup.sizeBytes, {
                              precision: 1,
                              unknownLabel: "—",
                            })}
                          </span>
                          <span>Backup ID: {backup.id.slice(0, 8)}</span>
                        </div>
                      </div>

                      <div className="flex flex-col items-start gap-2 lg:items-end">
                        {isRunning ? (
                          <BrandButton
                            variant="outline"
                            size="sm"
                            onClick={() => restoreBackup(backup.id)}
                            disabled={!!activeRestoreTarget}
                          >
                            {isRestoring ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RotateCcw className="h-4 w-4" />
                            )}
                            Restore this backup
                          </BrandButton>
                        ) : isLatest ? (
                          <p className="text-xs text-muted-strong">
                            Use &ldquo;Restore latest&rdquo; above for
                            stopped-agent recovery.
                          </p>
                        ) : (
                          <p className="text-xs text-muted">
                            Historical restores require a running agent.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </BrandCard>
  );
}
