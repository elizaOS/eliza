/**
 * ElizaAgentActions — client component for start/stop/snapshot/delete actions
 * on the agent detail page.
 */
"use client";

import { BrandButton, BrandCard } from "@elizaos/cloud-ui";
import { Camera, ExternalLink, Loader2, Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { openWebUIWithPairing } from "@/lib/hooks/open-web-ui";
import { useJobPoller } from "@/lib/hooks/use-job-poller";

interface ElizaAgentActionsProps {
  agentId: string;
  status: string;
}

export function ElizaAgentActions({ agentId, status }: ElizaAgentActionsProps) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const poller = useJobPoller({
    onComplete: () => toast.success("Agent provisioning completed"),
    onFailed: (job) => toast.error(job.error ?? "Provisioning failed"),
  });

  const trackedJob = poller.getStatus(agentId);
  const effectiveStatus = poller.isActive(agentId) ? "provisioning" : status;

  const isRunning = effectiveStatus === "running";
  const isStopped = ["stopped", "error", "pending", "disconnected"].includes(effectiveStatus);
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

      if ((action === "provision" || action === "resume") && res.status === 409) {
        const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
        if (jobId) {
          poller.track(agentId, jobId);
          toast.info("Provisioning already in progress");
          return;
        }
      }

      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      if (action === "delete") {
        toast.success("Agent deleted");
        navigate("/dashboard/agents");
        return;
      }

      if ((action === "provision" || action === "resume") && res.status === 202) {
        const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
        if (jobId) {
          poller.track(agentId, jobId);
          toast.success("Agent provisioning queued");
          return;
        }

        toast.success("Agent provisioning started");
        window.location.reload();
        return;
      }

      const messages: Record<string, string> = {
        provision: "Agent provisioning started",
        resume: "Agent resuming from snapshot",
        snapshot: "Snapshot saved",
        suspend: "Agent suspended (snapshot saved)",
      };
      toast.success(messages[action] ?? "Done");
      window.location.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Action failed: ${msg}`);
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
            Agent Actions
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
                Open Web UI
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
                Resume Agent
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
                Save Snapshot
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
                Suspend Agent
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
                Delete Agent
              </BrandButton>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-none border border-red-500/30 bg-red-950/20 p-3">
                <span
                  className="text-sm text-red-400"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  Confirm delete?
                </span>
                <BrandButton
                  variant="outline"
                  size="sm"
                  onClick={() => doAction("delete", "DELETE")}
                  disabled={!!loading}
                  className="text-red-400 border-red-500/50 hover:bg-red-500/20"
                >
                  {loading === "delete" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Yes, delete
                </BrandButton>
                <BrandButton
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="text-white/60"
                >
                  Cancel
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
              Agent is provisioning. This page will refresh when the job finishes.
            </p>
            {trackedJob && (
              <p
                className="text-xs text-white/40"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                Job {trackedJob.jobId.slice(0, 8)} • {trackedJob.status}
              </p>
            )}
          </div>
        )}
      </div>
    </BrandCard>
  );
}
