/**
 * ElizaAgentActions — client component for start/stop/snapshot/delete actions
 * on the agent detail page.
 */
"use client";

import { BrandButton, BrandCard } from "@elizaos/ui";
import {
  Camera,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { openWebUIWithPairing } from "@/lib/hooks/open-web-ui";
import { useJobPoller } from "@/lib/hooks/use-job-poller";
import { useT } from "@/providers/I18nProvider";

interface ElizaAgentActionsProps {
  agentId: string;
  status: string;
}

export function ElizaAgentActions({ agentId, status }: ElizaAgentActionsProps) {
  const t = useT();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const poller = useJobPoller({
    onComplete: () =>
      toast.success(
        t("cloud.containers.agentActions.provisioningCompleted", {
          defaultValue: "Agent provisioning completed",
        }),
      ),
    onFailed: (job) =>
      toast.error(
        job.error ??
          t("cloud.containers.agentActions.provisioningFailed", {
            defaultValue: "Provisioning failed",
          }),
      ),
  });

  const trackedJob = poller.getStatus(agentId);
  const effectiveStatus = poller.isActive(agentId) ? "provisioning" : status;

  const isRunning = effectiveStatus === "running";
  const isStopped = ["stopped", "error", "pending", "disconnected"].includes(
    effectiveStatus,
  );
  const isBusy = effectiveStatus === "provisioning";

  async function doAction(action: string, method = "POST") {
    setLoading(action);
    try {
      let url = `/api/v1/eliza/agents/${agentId}`;
      let body: string | undefined;

      if (action === "resume") {
        url = `/api/v1/eliza/agents/${agentId}/resume`;
      } else if (action === "provision") {
        url = `/api/v1/eliza/agents/${agentId}/provision`;
      } else if (action === "snapshot") {
        url = `/api/v1/eliza/agents/${agentId}/snapshot`;
      } else if (action === "delete") {
        method = "DELETE";
      } else if (action === "shutdown" || action === "suspend") {
        method = "PATCH";
        body = JSON.stringify({ action: "suspend" });
      }

      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
      });

      const data = await res.json().catch(() => ({}));
      const jobId = (data as { data?: { jobId?: string } }).data?.jobId;

      // 409 + jobId — operation already in flight, attach to the existing
      // job so the toast resolves when it actually completes.
      if (res.status === 409 && jobId) {
        poller.track(agentId, jobId);
        toast.info(
          t("cloud.containers.agentActions.actionAlreadyInProgress", {
            defaultValue: "{action} already in progress",
            action,
          }),
        );
        return;
      }

      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }

      if (action === "delete") {
        toast.success(
          t("cloud.containers.agentActions.agentDeleted", {
            defaultValue: "Agent deleted",
          }),
        );
        navigate("/dashboard/agents");
        return;
      }

      // 202 + jobId — the backend enqueued a job; track it and tell the
      // user it's running. Avoids the toast lying ("Snapshot saved")
      // before the daemon actually finished.
      if (res.status === 202 && jobId) {
        poller.track(agentId, jobId);
        const queuedMessages: Record<string, string> = {
          provision: t("cloud.containers.agentActions.provisioningQueued", {
            defaultValue: "Agent provisioning queued",
          }),
          resume: t("cloud.containers.agentActions.resumeQueued", {
            defaultValue: "Agent resume queued",
          }),
          snapshot: t("cloud.containers.agentActions.snapshotQueued", {
            defaultValue: "Snapshot queued",
          }),
          suspend: t("cloud.containers.agentActions.suspendQueued", {
            defaultValue: "Suspend queued",
          }),
          shutdown: t("cloud.containers.agentActions.suspendQueued", {
            defaultValue: "Suspend queued",
          }),
        };
        toast.success(
          queuedMessages[action] ??
            t("cloud.containers.agentActions.actionQueued", {
              defaultValue: "{action} queued",
              action,
            }),
        );
        return;
      }

      // Fallback: synchronous success (no jobId returned). Legacy
      // endpoints that still complete inline land here.
      const messages: Record<string, string> = {
        provision: t("cloud.containers.agentActions.provisioningStarted", {
          defaultValue: "Agent provisioning started",
        }),
        resume: t("cloud.containers.agentActions.resumingSnapshot", {
          defaultValue: "Agent resuming from snapshot",
        }),
        snapshot: t("cloud.containers.agentActions.snapshotSaved", {
          defaultValue: "Snapshot saved",
        }),
        suspend: t("cloud.containers.agentActions.suspended", {
          defaultValue: "Agent suspended (snapshot saved)",
        }),
      };
      toast.success(
        messages[action] ??
          t("cloud.containers.agentActions.done", { defaultValue: "Done" }),
      );
      window.location.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        `${t("cloud.containers.agentActions.actionFailed", { defaultValue: "Action failed" })}: ${msg}`,
      );
    } finally {
      setLoading(null);
      setShowDeleteConfirm(false);
    }
  }

  return (
    <BrandCard className="relative shadow-lg shadow-black/50" cornerSize="md">
      <div className="relative z-10 space-y-4">
        <div className="flex items-center gap-2 pb-4 border-b border-white/10">
          <span className="inline-block w-2 h-2 rounded-full bg-[#FF5800]" />
          <h2
            className="text-xl font-normal text-white"
            style={{ fontFamily: "var(--font-roboto-mono)" }}
          >
            {t("cloud.containers.agentActions.title", {
              defaultValue: "Agent Actions",
            })}
          </h2>
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-wrap gap-3">
            {isRunning && (
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => void openWebUIWithPairing(agentId)}
              >
                <ExternalLink className="h-4 w-4" />
                {t("cloud.containers.agentActions.openWebUi", {
                  defaultValue: "Open Web UI",
                })}
              </BrandButton>
            )}

            {isStopped && (
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => doAction("resume")}
                disabled={!!loading || isBusy}
              >
                {loading === "resume" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.resume", {
                  defaultValue: "Resume Agent",
                })}
              </BrandButton>
            )}

            {isRunning && (
              <BrandButton
                variant="outline"
                size="sm"
                onClick={() => doAction("snapshot")}
                disabled={!!loading || isBusy}
              >
                {loading === "snapshot" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.saveSnapshot", {
                  defaultValue: "Save Snapshot",
                })}
              </BrandButton>
            )}

            {isRunning && (
              <BrandButton
                variant="outline"
                size="sm"
                onClick={() => doAction("suspend", "PATCH")}
                disabled={!!loading || isBusy}
              >
                {loading === "suspend" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pause className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.suspend", {
                  defaultValue: "Suspend Agent",
                })}
              </BrandButton>
            )}
          </div>

          <div className="flex flex-wrap gap-2 lg:justify-end">
            {!showDeleteConfirm ? (
              <BrandButton
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={!!loading || isBusy}
                className="text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-4 w-4" />
                {t("cloud.containers.agentActions.delete", {
                  defaultValue: "Delete Agent",
                })}
              </BrandButton>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-sm border border-red-500/30 bg-red-950/20 p-3">
                <span
                  className="text-sm text-red-400"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {t("cloud.containers.agentActions.confirmDelete", {
                    defaultValue: "Confirm delete?",
                  })}
                </span>
                <BrandButton
                  variant="outline"
                  size="sm"
                  onClick={() => doAction("delete", "DELETE")}
                  disabled={!!loading}
                  className="text-red-400 border-red-500/50 hover:bg-red-500/20"
                >
                  {loading === "delete" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : null}
                  {t("cloud.containers.agentActions.yesDelete", {
                    defaultValue: "Yes, delete",
                  })}
                </BrandButton>
                <BrandButton
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="text-white/60"
                >
                  {t("cloud.containers.agentActions.cancel", {
                    defaultValue: "Cancel",
                  })}
                </BrandButton>
              </div>
            )}
          </div>
        </div>

        {poller.isActive(agentId) && (
          <div className="space-y-1">
            <p
              className="text-sm text-yellow-400/80 flex items-center gap-2"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("cloud.containers.agentActions.provisioningHint", {
                defaultValue:
                  "Agent is provisioning. This page will refresh when the job finishes.",
              })}
            </p>
            {trackedJob && (
              <p
                className="text-xs text-white/40"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {t("cloud.containers.agentActions.jobLabel", {
                  defaultValue: "Job",
                })}{" "}
                {trackedJob.jobId.slice(0, 8)} • {trackedJob.status}
              </p>
            )}
          </div>
        )}
      </div>
    </BrandCard>
  );
}
