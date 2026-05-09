"use client";

import { Badge, BrandButton, BrandCard, Skeleton } from "@elizaos/cloud-ui";
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

const SNAPSHOT_TYPE_LABELS: Record<BackupRecord["snapshotType"], string> = {
  auto: "Auto",
  manual: "Manual",
  "pre-shutdown": "Pre-shutdown",
};

const SNAPSHOT_TYPE_STYLES: Record<BackupRecord["snapshotType"], string> = {
  auto: "border-blue-500/40 bg-blue-500/10 text-blue-400",
  manual: "border-[#FF5800]/40 bg-[#FF5800]/10 text-[#FF9B66]",
  "pre-shutdown": "border-purple-500/40 bg-purple-500/10 text-purple-400",
};

function formatBytes(bytes: number | null): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const [activeRestoreTarget, setActiveRestoreTarget] = useState<string | null>(null);

  const isRunning = status === "running";
  const isBusy = status === "provisioning";

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/eliza/agents/${agentId}/backups`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !(payload as { success?: boolean }).success) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }

      setBackups(
        Array.isArray((payload as { data?: unknown[] }).data)
          ? ((payload as { data: BackupRecord[] }).data ?? [])
          : [],
      );
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
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
        return new Date(backup.createdAt) > new Date(latest.createdAt) ? backup : latest;
      }, null),
    [backups],
  );
  const manualCount = useMemo(
    () => backups.filter((backup) => backup.snapshotType === "manual").length,
    [backups],
  );
  const preShutdownCount = useMemo(
    () => backups.filter((backup) => backup.snapshotType === "pre-shutdown").length,
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
        const response = await fetch(`/api/v1/eliza/agents/${agentId}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(backupId ? { backupId } : {}),
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok || !(payload as { success?: boolean }).success) {
          throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
        }

        toast.success(
          isRunning
            ? "Backup restored"
            : "Latest backup restored. The agent was restarted with that state.",
        );

        await fetchBackups();
        window.location.reload();
      } catch (restoreError) {
        toast.error(restoreError instanceof Error ? restoreError.message : String(restoreError));
      } finally {
        setActiveRestoreTarget(null);
      }
    },
    [agentId, fetchBackups, isRunning, latestBackup],
  );

  return (
    <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="sm">
      <div className="relative z-10 space-y-6">
        <div className="flex flex-col gap-4 border-b border-white/10 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-[#FF5800]" />
              <h2
                className="text-xl font-normal text-white"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Backups & History
              </h2>
            </div>
            <p className="text-sm text-white/60">
              Snapshot history and restore controls for {agentName || "this agent"}.
            </p>
            <p className="mt-1 text-xs text-white/40">
              Use “Save Snapshot” above to capture the current running state.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <BrandButton variant="outline" size="sm" onClick={fetchBackups}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
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
          <div className="flex items-start gap-3 border border-yellow-500/30 bg-yellow-950/20 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" />
            <div className="space-y-1">
              <p className="text-sm text-yellow-300">This agent is not currently running.</p>
              <p className="text-xs text-yellow-200/80">
                For stopped agents, restores are limited to the latest backup only. Historical
                per-row restore actions stay hidden until the agent is running again.
              </p>
            </div>
          </div>
        )}

        {isBusy && (
          <div className="flex items-start gap-3 border border-blue-500/30 bg-blue-950/20 p-4">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-400" />
            <p className="text-sm text-blue-200/90">
              Provisioning is in progress. Wait for the agent to finish starting before restoring.
            </p>
          </div>
        )}

        {loading ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-24 rounded-none" />
              <Skeleton className="h-24 rounded-none" />
              <Skeleton className="h-24 rounded-none" />
            </div>
            <Skeleton className="h-16 rounded-none" />
            <Skeleton className="h-16 rounded-none" />
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <History className="mx-auto mb-3 h-8 w-8 text-neutral-600" />
            <p className="mb-1 text-sm text-red-400">Failed to load backups</p>
            <p className="text-xs text-white/40">{error}</p>
            <BrandButton variant="outline" size="sm" onClick={fetchBackups} className="mt-4">
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </BrandButton>
          </div>
        ) : backups.length === 0 ? (
          <div className="py-10 text-center">
            <DatabaseBackup className="mx-auto mb-3 h-8 w-8 text-neutral-600" />
            <p className="text-sm text-white/60">No backups yet</p>
            <p className="mt-1 text-xs text-white/40">
              Run the agent and save a snapshot to create the first restore point.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="border border-white/10 bg-black/20 p-4 text-center">
                <p
                  className="text-2xl font-medium text-white"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {backups.length}
                </p>
                <p
                  className="mt-1 text-xs uppercase tracking-wider text-white/60"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  Total backups
                </p>
              </div>
              <div className="border border-white/10 bg-black/20 p-4 text-center">
                <p
                  className="text-lg font-medium text-[#FF9B66]"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {manualCount}
                </p>
                <p
                  className="mt-1 text-xs uppercase tracking-wider text-white/60"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  Manual snapshots
                </p>
              </div>
              <div className="border border-white/10 bg-black/20 p-4 text-center">
                <p
                  className="text-lg font-medium text-purple-400"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {preShutdownCount}
                </p>
                <p
                  className="mt-1 text-xs uppercase tracking-wider text-white/60"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
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
                    className="border border-white/10 bg-black/30 p-4 transition-colors hover:border-white/20 hover:bg-black/40"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {isLatest && (
                            <Badge
                              variant="outline"
                              className="border-green-500/40 bg-green-500/10 text-green-400"
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
                          <p
                            className="text-sm font-medium text-white"
                            style={{ fontFamily: "var(--font-roboto-mono)" }}
                          >
                            {timestamp.absolute}
                          </p>
                          <p className="text-xs text-white/50">{timestamp.relative}</p>
                        </div>

                        <div className="flex flex-wrap items-center gap-4 text-xs text-white/50">
                          <span style={{ fontFamily: "var(--font-roboto-mono)" }}>
                            Size: {formatBytes(backup.sizeBytes)}
                          </span>
                          <span style={{ fontFamily: "var(--font-roboto-mono)" }}>
                            Backup ID: {backup.id.slice(0, 8)}
                          </span>
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
                          <p className="text-xs text-white/50">
                            Use “Restore latest” above for stopped-agent recovery.
                          </p>
                        ) : (
                          <p className="text-xs text-white/40">
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
