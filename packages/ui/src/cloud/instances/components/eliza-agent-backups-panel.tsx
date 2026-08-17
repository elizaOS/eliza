"use client";

/**
 * Lists authoritative backup metadata for one cloud agent and confirms restore
 * requests without allowing superseded agent responses to update the panel.
 */
import { formatByteSize } from "@elizaos/shared/utils/format";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  BrandButton,
  BrandCard,
  Skeleton,
} from "@elizaos/ui/cloud-ui";
import { formatDistanceToNowStrict } from "date-fns";
import {
  AlertTriangle,
  DatabaseBackup,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api-client";

interface ElizaAgentBackupsPanelProps {
  agentId: string;
  agentName: string;
  status: string;
}

const SNAPSHOT_TYPES = [
  "auto",
  "manual",
  "pre-shutdown",
  "pre-delete",
  "pre-upgrade",
  "pre-move",
] as const;

type SnapshotType = (typeof SNAPSHOT_TYPES)[number];

interface BackupRecord {
  id: string;
  snapshotType: SnapshotType;
  sizeBytes: number | null;
  createdAt: string;
}

interface RestoreOutcome {
  kind: "success" | "error";
  message: string;
}

const SNAPSHOT_TYPE_PRESENTATION: Record<
  SnapshotType,
  { label: string; className: string }
> = {
  auto: {
    label: "Auto",
    className: "border-border bg-bg-muted text-muted-strong",
  },
  manual: {
    label: "Manual",
    className: "border-accent/40 bg-accent-subtle text-accent",
  },
  "pre-shutdown": {
    label: "Pre-shutdown",
    className: "border-border-strong bg-surface text-txt-strong",
  },
  "pre-delete": {
    label: "Pre-delete",
    className:
      "border-status-warning/40 bg-status-warning-bg text-status-warning",
  },
  "pre-upgrade": {
    label: "Pre-upgrade",
    className:
      "border-status-warning/40 bg-status-warning-bg text-status-warning",
  },
  "pre-move": {
    label: "Pre-move",
    className: "border-border-strong bg-surface text-muted-strong",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshotType(value: unknown): value is SnapshotType {
  return SNAPSHOT_TYPES.some((snapshotType) => snapshotType === value);
}

function isValidCreatedAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.includes("T") &&
    Number.isFinite(Date.parse(value))
  );
}

function parseBackupRecord(value: unknown): BackupRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    !isSnapshotType(value.snapshotType) ||
    !(
      value.sizeBytes === null ||
      (typeof value.sizeBytes === "number" &&
        Number.isSafeInteger(value.sizeBytes) &&
        value.sizeBytes >= 0)
    ) ||
    !isValidCreatedAt(value.createdAt)
  ) {
    throw new Error("Backup response contained an invalid backup record");
  }

  return {
    id: value.id,
    snapshotType: value.snapshotType,
    sizeBytes: value.sizeBytes,
    createdAt: value.createdAt,
  };
}

function parseBackupsResponse(payload: unknown): BackupRecord[] {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !Array.isArray(payload.data)
  ) {
    throw new Error("Backup response did not include a successful data list");
  }
  return payload.data.map(parseBackupRecord);
}

function parseRestoreResponse(
  payload: unknown,
  expectedBackupId: string,
): void {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.data)
  ) {
    throw new Error("Restore response did not include a successful result");
  }

  const { restoredFromBackupId, snapshotType, createdAt } = payload.data;
  if (
    restoredFromBackupId !== expectedBackupId ||
    !isSnapshotType(snapshotType) ||
    !isValidCreatedAt(createdAt)
  ) {
    throw new Error("Restore response contained an invalid backup result");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const [listAgentId, setListAgentId] = useState(agentId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [activeRestoreTarget, setActiveRestoreTarget] = useState<string | null>(
    null,
  );
  const [restoreOutcome, setRestoreOutcome] = useState<RestoreOutcome | null>(
    null,
  );
  const listGenerationRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const restoreGenerationRef = useRef(0);
  const restoreAbortRef = useRef<AbortController | null>(null);

  const isRunning = status === "running";
  const isBusy = status === "provisioning";

  const fetchBackups = useCallback(async () => {
    const generation = ++listGenerationRef.current;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    setLoading(true);
    setError(null);

    try {
      const payload = await api<unknown>(
        `/api/v1/eliza/agents/${agentId}/backups`,
        { cache: "no-store", signal: controller.signal },
      );
      const nextBackups = parseBackupsResponse(payload);
      if (
        controller.signal.aborted ||
        generation !== listGenerationRef.current
      ) {
        return;
      }

      setBackups(nextBackups);
      setListAgentId(agentId);
      setRestoreTarget((target) =>
        target
          ? (nextBackups.find((backup) => backup.id === target.id) ?? null)
          : null,
      );
    } catch (fetchError) {
      // error-policy:J4 only the active agent request reaches the visible
      // panel error; aborted and superseded requests remain invisible.
      if (
        controller.signal.aborted ||
        generation !== listGenerationRef.current ||
        isAbortError(fetchError)
      ) {
        return;
      }
      setError(errorMessage(fetchError));
      setListAgentId(agentId);
    } finally {
      if (generation === listGenerationRef.current) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setBackups([]);
    setError(null);
    setLoading(true);
    setRestoreTarget(null);
    setActiveRestoreTarget(null);
    setRestoreOutcome(null);
    void fetchBackups();

    return () => {
      listGenerationRef.current += 1;
      restoreGenerationRef.current += 1;
      listAbortRef.current?.abort();
      restoreAbortRef.current?.abort();
    };
  }, [fetchBackups]);

  const visibleBackups = listAgentId === agentId ? backups : [];
  const latestBackup = useMemo(
    () =>
      visibleBackups.reduce<BackupRecord | null>((latest, backup) => {
        if (!latest) return backup;
        return Date.parse(backup.createdAt) > Date.parse(latest.createdAt)
          ? backup
          : latest;
      }, null),
    [visibleBackups],
  );
  const manualCount = useMemo(
    () =>
      visibleBackups.filter((backup) => backup.snapshotType === "manual")
        .length,
    [visibleBackups],
  );
  const preShutdownCount = useMemo(
    () =>
      visibleBackups.filter((backup) => backup.snapshotType === "pre-shutdown")
        .length,
    [visibleBackups],
  );

  const restoreBackup = useCallback(async () => {
    if (!restoreTarget || isBusy) return;
    if (!isRunning && restoreTarget.id !== latestBackup?.id) {
      setRestoreOutcome({
        kind: "error",
        message: "Stopped agents can only restore the latest backup",
      });
      return;
    }

    const generation = ++restoreGenerationRef.current;
    restoreAbortRef.current?.abort();
    const controller = new AbortController();
    restoreAbortRef.current = controller;
    setActiveRestoreTarget(restoreTarget.id);
    setRestoreOutcome(null);

    try {
      const payload = await api<unknown>(
        `/api/v1/eliza/agents/${agentId}/restore`,
        {
          method: "POST",
          json: { backupId: restoreTarget.id },
          signal: controller.signal,
        },
      );
      parseRestoreResponse(payload, restoreTarget.id);
      if (
        controller.signal.aborted ||
        generation !== restoreGenerationRef.current
      ) {
        return;
      }

      const message = "Backup restored successfully.";
      setRestoreOutcome({ kind: "success", message });
      setRestoreTarget(null);
      toast.success(message);
      void fetchBackups();
    } catch (restoreError) {
      // error-policy:J4 restore failure stays inside its confirmation boundary;
      // an agent switch or unmount aborts it without leaking stale feedback.
      if (
        controller.signal.aborted ||
        generation !== restoreGenerationRef.current ||
        isAbortError(restoreError)
      ) {
        return;
      }
      const message = errorMessage(restoreError);
      setRestoreOutcome({ kind: "error", message });
      toast.error(message);
    } finally {
      if (generation === restoreGenerationRef.current) {
        setActiveRestoreTarget(null);
      }
    }
  }, [agentId, fetchBackups, isBusy, isRunning, latestBackup, restoreTarget]);

  const restoreDisallowed =
    !restoreTarget ||
    isBusy ||
    (!isRunning && restoreTarget.id !== latestBackup?.id);

  function requestRestore(backup: BackupRecord) {
    setRestoreOutcome(null);
    setRestoreTarget(backup);
  }

  return (
    <BrandCard className="relative" cornerSize="sm">
      <div className="relative z-10 space-y-6">
        <div className="flex flex-col gap-4 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full bg-accent"
              />
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
            <BrandButton
              variant="outline"
              size="sm"
              onClick={() => void fetchBackups()}
              disabled={loading}
            >
              <RefreshCw
                aria-hidden="true"
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </BrandButton>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={() => {
                if (latestBackup) requestRestore(latestBackup);
              }}
              disabled={
                loading || !latestBackup || !!activeRestoreTarget || isBusy
              }
            >
              {activeRestoreTarget === latestBackup?.id ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw aria-hidden="true" className="h-4 w-4" />
              )}
              Restore latest
            </BrandButton>
          </div>
        </div>

        {restoreOutcome?.kind === "success" ? (
          <div
            className="border border-status-success/30 bg-status-success-bg p-4 text-sm text-status-success"
            role="status"
          >
            {restoreOutcome.message}
          </div>
        ) : null}

        {!isRunning && latestBackup ? (
          <div className="flex items-start gap-3 border border-status-warning/30 bg-status-warning-bg p-4">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
            />
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
        ) : null}

        {isBusy ? (
          <div className="flex items-start gap-3 border border-border-strong bg-bg-muted p-4">
            <Loader2
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-strong"
            />
            <p className="text-sm text-txt-strong">
              Provisioning is in progress. Wait for the agent to finish starting
              before restoring.
            </p>
          </div>
        ) : null}

        {loading || listAgentId !== agentId ? (
          <div className="space-y-4" role="status" aria-live="polite">
            <span className="sr-only">Loading backups</span>
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-24 rounded-sm" />
              <Skeleton className="h-24 rounded-sm" />
              <Skeleton className="h-24 rounded-sm" />
            </div>
            <Skeleton className="h-16 rounded-sm" />
            <Skeleton className="h-16 rounded-sm" />
          </div>
        ) : error ? (
          <div className="py-8 text-center" role="alert">
            <History
              aria-hidden="true"
              className="mx-auto mb-3 h-8 w-8 text-muted"
            />
            <p className="mb-1 text-sm text-destructive">
              Failed to load backups
            </p>
            <p className="break-words text-xs text-muted">{error}</p>
            <BrandButton
              variant="outline"
              size="sm"
              onClick={() => void fetchBackups()}
              className="mt-4"
            >
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Retry
            </BrandButton>
          </div>
        ) : visibleBackups.length === 0 ? (
          <div className="py-10 text-center">
            <DatabaseBackup
              aria-hidden="true"
              className="mx-auto mb-3 h-8 w-8 text-muted"
            />
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
                  {visibleBackups.length}
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
              {visibleBackups.map((backup) => {
                const timestamp = formatTimestamp(backup.createdAt);
                const isLatest = backup.id === latestBackup?.id;
                const isRestoring = activeRestoreTarget === backup.id;
                const presentation =
                  SNAPSHOT_TYPE_PRESENTATION[backup.snapshotType];

                return (
                  <div
                    key={backup.id}
                    className="border border-border bg-card p-4 transition-colors hover:border-border-strong hover:bg-bg-hover"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {isLatest ? (
                            <Badge
                              variant="outline"
                              className="border-status-success/40 bg-status-success-bg text-status-success"
                            >
                              Latest
                            </Badge>
                          ) : null}
                          <Badge
                            variant="outline"
                            className={presentation.className}
                          >
                            {presentation.label}
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
                            onClick={() => requestRestore(backup)}
                            disabled={loading || !!activeRestoreTarget}
                          >
                            {isRestoring ? (
                              <Loader2
                                aria-hidden="true"
                                className="h-4 w-4 animate-spin"
                              />
                            ) : (
                              <RotateCcw
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
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

      <AlertDialog
        open={restoreTarget !== null && listAgentId === agentId}
        onOpenChange={(open) => {
          if (!open && !activeRestoreTarget) {
            setRestoreTarget(null);
            setRestoreOutcome(null);
          }
        }}
      >
        <AlertDialogContent className="border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-txt-strong">
              Restore this backup?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted">
              This replaces the current state for {agentName || "this agent"}
              {restoreTarget ? (
                <span className="mt-2 block font-mono text-xs text-muted-strong">
                  {SNAPSHOT_TYPE_PRESENTATION[restoreTarget.snapshotType].label}{" "}
                  backup from{" "}
                  {formatTimestamp(restoreTarget.createdAt).absolute}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {restoreOutcome?.kind === "error" ? (
            <div
              className="border border-destructive/20 bg-destructive-subtle p-3 text-sm text-destructive"
              role="alert"
            >
              {restoreOutcome.message}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel
              className="border-border bg-transparent text-txt hover:bg-surface"
              disabled={!!activeRestoreTarget}
            >
              Cancel
            </AlertDialogCancel>
            <BrandButton
              type="button"
              onClick={() => void restoreBackup()}
              disabled={restoreDisallowed || !!activeRestoreTarget}
            >
              {activeRestoreTarget ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw aria-hidden="true" className="h-4 w-4" />
              )}
              {activeRestoreTarget ? "Restoring…" : "Restore backup"}
            </BrandButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </BrandCard>
  );
}
